#!/usr/bin/env tsx
/**
 * check-ses-inbound-region.ts — AC-c7 (계획 §3.3 "Day-0 필수 작업", §6.0 항목 4)
 *
 * SES 이메일 *수신*은 발신과 달리 제한된 리전 집합에서만 제공돼 왔다.
 * 서울(ap-northeast-2)에서 수신이 안 되면 P3 착수 시점(약 12주차)에 2-리전
 * 아키텍처로 CDK·IAM·레이턴시 설계를 다시 짜야 한다 — Principle P5가 말하는
 * "나중에 발견하면 몇 주를 잃는" 종류다.
 *
 * ── 결론은 이미 나 있다 ────────────────────────────────────────────────
 * 2026-09-22 수동 확인: AWS 공식 엔드포인트 표에 inbound-smtp.ap-northeast-2.amazonaws.com
 * 이 존재한다. **서울은 수신을 지원한다.** 2-리전 설계 불필요, ADR-0004 불발동, Q13 종결.
 * 이 스크립트는 그 결론을 기계가 다시 확인할 수 있게 고정한 것이다 —
 * 사람의 기억이 아니라 명령 한 줄이 근거가 되도록.
 *
 * 검증 방법: 수신 엔드포인트의 DNS 해석 가능 여부.
 *   AWS는 수신을 지원하는 리전에만 inbound-smtp.<region>.amazonaws.com 을 게시한다.
 *   receipt rule set 을 실제로 만들어 보는 편이 더 강한 증명이지만, 그러려면
 *   @aws-sdk/client-sesv2 를 import해야 하고 그것은 Layer A(SES SDK를 import하는 파일은
 *   src/mail/transport/ses-transport.ts 하나뿐)를 깨뜨린다. 외부 패키지 없이 얻을 수 있는
 *   가장 강한 신호를 택한다.
 *
 * 외부 패키지 금지: Node 내장 node:dns/promises 만 쓴다.
 * exit 0 = 지원 확인, exit 1 = 미해석(= ADR-0004 개시 신호).
 */

import { resolve4, resolve6 } from 'node:dns/promises';

const PRIMARY_REGION = 'ap-northeast-2';
/** 서울이 무너졌을 때의 후보. 순서는 레이턴시 기준. */
const FALLBACK_REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1'] as const;

interface RegionProbe {
  readonly region: string;
  readonly endpoint: string;
  readonly supported: boolean;
  readonly addresses: readonly string[];
}

async function probe(region: string): Promise<RegionProbe> {
  const endpoint = `inbound-smtp.${region}.amazonaws.com`;
  const v4 = await resolve4(endpoint).catch(() => [] as string[]);
  const v6 = v4.length > 0 ? [] : await resolve6(endpoint).catch(() => [] as string[]);
  const addresses = [...v4, ...v6];
  return { region, endpoint, supported: addresses.length > 0, addresses };
}

async function main(): Promise<void> {
  console.log('\nSES 이메일 수신(inbound) 리전 가용성 점검 — AC-c7\n');

  const primary = await probe(PRIMARY_REGION);
  console.log(`${primary.supported ? '✓' : '✗'} ${primary.region}  [${primary.endpoint}]`);
  console.log(`     해석: ${primary.supported ? primary.addresses.join(', ') : '실패 (레코드 없음)'}`);
  console.log('');

  if (primary.supported) {
    console.log('판정: 서울(ap-northeast-2)은 SES 이메일 수신을 지원한다.');
    console.log('  - 2-리전 아키텍처 불필요. P3 inbound 파이프라인은 단일 리전으로 설계한다.');
    console.log('  - docs/adr/0004-inbound-region.md 는 열지 않는다 (ADR-0004 불발동).');
    console.log('  - 2026-09-22 수동 확인과 일치한다.\n');
    process.exitCode = 0;
    return;
  }

  console.log('판정: 서울에서 수신 엔드포인트가 해석되지 않는다.');
  console.log('후보 리전을 조회한다 — 수신 전용 리전을 두고 처리는 서울에서 하는 구성이 된다.\n');
  for (const region of FALLBACK_REGIONS) {
    const p = await probe(region);
    console.log(`${p.supported ? '✓' : '✗'} ${p.region}  [${p.endpoint}]`);
  }
  console.log('');
  console.log('조치: 즉시 docs/adr/0004-inbound-region.md 를 열고 수신 리전을 결정한다.');
  console.log('      CDK 스택 분리·IAM 교차리전 신뢰·레이턴시 예산이 함께 달린다 (계획 §3.3 Day-0).\n');
  process.exitCode = 1;
}

await main();
