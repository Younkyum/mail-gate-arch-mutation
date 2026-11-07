#!/bin/bash
# 블라인드 변이 실험(논문 2.5.5절, 표 9) 재현.
# 패치를 하나씩 저장소에 적용 → (infra 변경 시) CDK synth → 타입 검사 → arch 스위트 → 실패 테스트 기록 → 원상 복구.
# 실행 전 작업 트리가 깨끗해야 한다(커밋되지 않은 변경은 복구 단계에서 사라진다).
#
#   bash reproduction/run-blind.sh            # 결과: reproduction/out/blind/summary.txt
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUT="$ROOT/reproduction/blind-mutations"
OUT="$ROOT/reproduction/out/blind"
mkdir -p "$OUT"
cd "$ROOT"
export ATMARK_TEST_WORKERS="${ATMARK_TEST_WORKERS:-2}"

restore() {
  git reset -q --hard HEAD
  git clean -fdq -e reproduction/out   # 새로 생긴 파일만 지운다(ignored 산출물·결과 폴더는 유지)
}

if [ -n "$(git status --porcelain -- . ':!reproduction/out')" ]; then echo "작업 트리가 깨끗하지 않다"; exit 1; fi

for patch in "$MUT"/m*.patch; do
  id=$(basename "$patch" .patch)
  echo "== $id"
  if grep -q "^$id " "$OUT/summary.txt" 2>/dev/null; then echo skip; continue; fi
  if ! git apply "$patch"; then echo "$id APPLY_FAIL" | tee -a "$OUT/summary.txt"; restore; continue; fi
  touched_infra=0
  if git status --porcelain | grep -q " infra/\|?? infra/"; then touched_infra=1; fi
  if [ $touched_infra = 1 ]; then pnpm exec cdk synth --quiet > "$OUT/$id.synth.log" 2>&1; fi
  tc_new=$(nice -n 15 node_modules/.bin/tsc --noEmit -p . 2>&1 | grep "error TS" | grep -v "^scripts/" | wc -l | tr -d ' ')
  nice -n 15 pnpm exec vitest run --project arch --maxWorkers=2 --reporter=json --outputFile="$OUT/$id.json" > "$OUT/$id.log" 2>&1
  node -e '
    const r=require(process.argv[1]);const f=[];
    for(const t of r.testResults){ if(!t.assertionResults.length && t.status==="failed") f.push(t.name.split("/test/arch/")[1]+" :: (file failed) "+(t.message||"").slice(0,120));
      for(const a of t.assertionResults) if(a.status==="failed") f.push(t.name.split("/test/arch/")[1]+" :: "+a.fullName);}
    console.log(JSON.stringify({failed:r.numFailedTests,tests:f}));' "$OUT/$id.json" > "$OUT/$id.failed.json"
  nf=$(node -e 'console.log(require(process.argv[1]).failed)' "$OUT/$id.failed.json")
  echo "$id infra=$touched_infra tsc_new_errors=$tc_new arch_failed=$nf" | tee -a "$OUT/summary.txt"
  restore
  if [ $touched_infra = 1 ]; then pnpm exec cdk synth --quiet > /dev/null 2>&1; fi
done

nice -n 15 pnpm exec vitest run --project arch --maxWorkers=2 --reporter=json --outputFile="$OUT/baseline_after.json" > /dev/null 2>&1
node -e 'const r=require(process.argv[1]);console.log("baseline_after failed="+r.numFailedTests+" total="+r.numTotalTests)' "$OUT/baseline_after.json" | tee -a "$OUT/summary.txt"
