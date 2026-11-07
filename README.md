# mail-gate-arch-mutation

학부 졸업논문 **「AI 에이전트 메일 발송 관문의 우회 방지를 위한 다층 아키텍처 검사와 변이 하네스의 구현 및 평가」**(진윤겸, 한국외국어대학교 컴퓨터공학부, 2026)의 재현용 저장소입니다.

논문의 대상 시스템은 실제 서비스로 운영되다가 지금은 운영을 멈춘 AI 에이전트 메일 인프라입니다. 이 저장소에는 그 시스템의 소스 코드 스냅샷(측정 기준 커밋, 2026-10-15)과 실험 자료가 들어 있습니다.

## 무엇이 들어 있나

| 경로 | 내용 | 논문 |
|---|---|---|
| `src/`, `infra/`, `ops/`, `scripts/`, `sdk/` | 대상 시스템 소스 코드 (관문: `src/policy/gate.ts`) | 2.1절 |
| `test/arch/` | 다층 아키텍처 검사 (A~E층 및 경계 검사 층, 33개 파일, 350개 테스트) | 2.2절, 표 1·2 |
| `test/arch/mutations/catalogue.ts` | 비공허성 변이 카탈로그 61종 (F층) | 2.3절, 표 3·4 |
| `test/arch/mutations/run-mutations.ts` | 변이 하네스 러너 (테스트 단위 JSON 판정, SHA-256 잔재 검사) | 2.3절 |
| `reproduction/blind-mutations/` | 블라인드 변이 15종 패치와 메타데이터(`meta.jsonl`) | 2.5.5절, 표 9 |
| `reproduction/blind-results/` | 블라인드 변이별 실패 테스트 목록과 요약 | 표 9 |
| `reproduction/run-blind.sh` | 블라인드 실험 재실행 스크립트 | 2.5.5절 |
| `reproduction/defects/vacuous-defects.md` | 공허한 검사 결함 30건 데이터셋 (유형 T1~T6, 발견 경로) | 2.5.2~2.5.3절, 표 5·6 |
| `reproduction/results/` | 이 저장소에서 다시 측정한 arch 리포트와 변이 하네스 로그 | 2.5.1절, 표 8 |
| `.github/workflows/arch-mutation.yml` | CI의 변이 하네스 작업 (`timeout-minutes: 60`) | 3.4절 |

## 재현 방법

필요한 것: Node.js 22 이상, pnpm 10.10, git. **AWS 계정·DB·네트워크 발송은 필요 없습니다.** 아래 명령은 모두 로컬에서 정적 분석과 CDK synth만 합니다.

```bash
pnpm install
pnpm build:lambda                 # E층 검사가 읽는 Lambda 번들
pnpm exec cdk synth --quiet       # E층 검사가 읽는 CloudFormation 산출물(cdk.out)
```

E층(IAM 발송 주체) 검사는 `cdk.out`이 없으면 일부러 실패합니다. 입력이 비어 있을 때 검사가 공허하게 통과하지 않도록 만든 장치입니다(논문 2.5.1절).

### 1. 아키텍처 검사 (기준선)

```bash
ATMARK_TEST_WORKERS=2 pnpm test:arch
```

기대 결과: 350개 테스트 모두 통과.

### 2. 변이 하네스 61종 (표 4, 표 8)

```bash
ATMARK_TEST_WORKERS=2 pnpm mutations
```

기대 결과: `Layer F: 변이 61종 전부를 겨냥한 층이 잡았다. 잔재 0, 복구 후 기준선 green.`

변이는 작업 트리의 실제 파일을 덮어썼다가 되돌립니다. **커밋되지 않은 변경이 없는 상태에서** 실행하세요.

### 3. 블라인드 변이 15종 (표 9)

```bash
bash reproduction/run-blind.sh
```

패치를 하나씩 적용해 arch 스위트 전체를 돌리고 원상 복구합니다. 결과는 `reproduction/out/blind/summary.txt`에 쌓입니다. 기대 결과: `arch_failed`가 0보다 큰 변이 8종(m01, m02, m06, m08, m09, m10, m11, m12), 0인 변이 7종(m03, m04, m05, m07, m13, m14, m15).

## 재측정 결과 (2026-11-07, Apple M3 Pro, Node 26, 워커 2개)

| 단계 | 결과 | 시간 |
|---|---|---|
| Lambda 번들 | 성공 | 4초 |
| CDK synth | 성공 | 3초 |
| arch 스위트 | 350/350 통과 | 118초 |
| 변이 하네스 | 61/61 탐지, 잔재 0 | 627초 |

블라인드 패치 15종은 이 스냅샷에 모두 깨끗하게 적용됨을 확인했습니다(`git apply --check`). 표 9의 탐지 결과(`reproduction/blind-results/`)는 논문 측정 당시의 원본 기록입니다.

## 원본과 다른 점

- 개발 이력(커밋 326개)은 포함하지 않고 측정 기준 시점의 스냅샷 하나만 올렸습니다. `vacuous-defects.md`의 커밋 해시는 원본 비공개 저장소의 해시라 이 저장소에서는 찾을 수 없습니다.
- 실험과 무관한 내부 문서(`docs/` 대부분), 개발 계획 문서, 사이트 자산, 배포 워크플로는 뺐습니다. arch 검사가 직접 읽는 문서 4개만 남겼습니다.
- 실제 AWS 계정 번호는 예시 값 `123456789012`로 바꿨습니다.
- 서비스는 운영을 멈췄으므로 코드에 나오는 도메인과 주소는 현재 동작하지 않습니다.
