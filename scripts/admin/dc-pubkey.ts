#!/usr/bin/env tsx
/**
 * scripts/admin/dc-pubkey.ts — `pnpm admin:dc-pubkey [--key alias/atmark-domain-connect-signing] [--region ap-northeast-2] [--verify]`
 *
 * Domain Connect 서명 키(KMS RSA_2048 — `infra/cdk/stacks/compute-stack.ts` `DOMAIN_CONNECT_KEY_ALIAS`)의 **공개키**를 읽어 Cloudflare 에 넣을
 * TXT 레코드(`_dcpubkeyv1.dc.atmark.ai` — 템플릿 `syncPubKeyDomain`)를 찍는다. 공개키라 비밀이 아니다(개인키는 KMS 밖으로 나오지 않는다).
 * 사람이 Cloudflare DNS 에 값 하나당 TXT 레코드 하나로 넣는다(같은 이름 · 여러 레코드 · DNS only).
 * `--verify` 는 공개 DNS 의 그 이름을 읽어 재조립한 키가 KMS 공개키와 같은지 본다(게시 확인 — 다르면 exit 1).
 * 필요한 권한: 운영자 프로필(`atmark`)의 `kms:GetPublicKey`(admin λ 역할이 아니다). 런북 deploy §Domain Connect.
 */

import { resolveTxt } from 'node:dns/promises';
import { parseArgs } from 'node:util';

import { createDcKmsClient, dcPublicKeySpki } from '../../src/domains/dc-kms-signer';
import { DC_PUBKEY_DOMAIN, DC_PUBKEY_LABEL, pubkeyTxtValues, spkiFromPubkeyTxt } from '../../src/domains/dc-url';
import { EXIT_FAILURE, EXIT_OK, isMain, runAdminMain, type AdminDeps } from './common';

export const DC_KEY_ALIAS_DEFAULT = 'alias/atmark-domain-connect-signing';
const USAGE = 'pnpm admin:dc-pubkey [--key alias/atmark-domain-connect-signing] [--region ap-northeast-2] [--verify]';

export async function main(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { key: { type: 'string' }, region: { type: 'string' }, verify: { type: 'boolean' }, help: { type: 'boolean' } },
    strict: true,
  });
  if (values.help === true) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  const spki = await dcPublicKeySpki(createDcKmsClient(values.region ?? 'ap-northeast-2'), values.key ?? DC_KEY_ALIAS_DEFAULT);
  const name = `${DC_PUBKEY_LABEL}.${DC_PUBKEY_DOMAIN}`;
  const records = pubkeyTxtValues(spki);
  deps.io.out(`# Cloudflare DNS (atmark.ai 존) — TXT ${String(records.length)}개, 이름 ${name}, DNS only, TTL Auto`);
  for (const value of records) deps.io.out(`${name}\tTXT\t"${value}"`);
  if (values.verify !== true) return EXIT_OK;
  let published: string[][];
  try {
    published = await resolveTxt(name);
  } catch {
    deps.io.err(`${name} TXT 를 읽지 못했다(아직 게시 전이거나 전파 중).`);
    return EXIT_FAILURE;
  }
  const txtValues = published.map((chunks) => chunks.join('')).filter((value) => value.startsWith('p='));
  const same = spkiFromPubkeyTxt(txtValues).equals(spki);
  deps.io.err(same ? `게시 확인: ${name} 의 공개키가 KMS 키와 같다.` : `불일치: ${name} 의 공개키가 KMS 키와 다르다.`);
  return same ? EXIT_OK : EXIT_FAILURE;
}

if (isMain(import.meta.url)) await runAdminMain(main);
