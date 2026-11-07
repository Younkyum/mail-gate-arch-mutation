"""
test/fixtures/eml/_generate.py — 인코딩 픽스처 생성기.

`.eml` 은 **바이트**가 요점이다(EUC-KR·CP949·ISO-2022-KR·QP). 손으로 편집하면 에디터가 UTF-8 로
다시 저장해 픽스처가 조용히 다른 것을 시험하게 된다 — 그래서 생성기를 같이 둔다.

**인코더를 python 표준 코덱으로 쓰는 이유:** 파서 쪽 CP949 디코더(`src/mail/mime/parse-charset.ts`)는
확장 표를 알고리즘으로 만든다. 픽스처를 같은 알고리즘으로 만들면 테스트가 자기 자신을 검증한다.
python 의 `cp949`·`euc_kr`·`iso2022_kr` 코덱은 그 코드와 독립이다.

다시 만들 때: `python3 test/fixtures/eml/_generate.py`
도메인은 전부 `example.*`·`atmark.ai` 다. 실제 서비스 이름을 쓰지 않는다.
"""
import base64
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CRLF = b"\r\n"


def b64(data: bytes) -> bytes:
    encoded = base64.b64encode(data)
    return CRLF.join(encoded[i:i + 76] for i in range(0, len(encoded), 76)) or b""


def word(charset: str, data: bytes) -> bytes:
    return b"=?" + charset.encode() + b"?B?" + base64.b64encode(data) + b"?="


def qp(data: bytes) -> bytes:
    """quoted-printable (RFC 2045 §6.7) — 76자 소프트 줄바꿈, =XX 를 자르지 않는다."""
    lines = []
    for raw in data.split(b"\n"):
        raw = raw.rstrip(b"\r")
        enc = "".join(
            chr(b) if (33 <= b <= 126 and b != 61) or b == 32 else "=%02X" % b for b in raw
        )
        if enc.endswith(" "):
            enc = enc[:-1] + "=20"
        while len(enc) > 75:
            cut = 75
            while "=" in enc[cut - 2:cut]:
                cut -= 1
            lines.append(enc[:cut] + "=")
            enc = enc[cut:]
        lines.append(enc)
    return "\r\n".join(lines).encode("ascii")


def headers(*lines) -> bytes:
    return CRLF.join(l if isinstance(l, bytes) else l.encode("utf-8") for l in lines) + CRLF + CRLF


def pct(data: bytes) -> str:
    return "".join("%%%02X" % b for b in data)


def write(name: str, *chunks) -> None:
    with open(os.path.join(HERE, name), "wb") as f:
        for c in chunks:
            f.write(c if isinstance(c, bytes) else c.encode("utf-8"))


# 1. UTF-8 + quoted-printable + RFC 2047 UTF-8 제목 + 따옴표 한글 표시 이름(raw UTF-8, RFC 6532)
write(
    "utf8-qp-verification.eml",
    headers(
        'From: "가상서비스 인증센터" <noreply@svc.example.com>',
        "To: agent+signup@atmark.ai",
        b"Subject: " + word("UTF-8", "[가상서비스] 이메일 인증 코드 안내".encode()),
        "Message-ID: <verify-001@mail.svc.example.com>",
        "Date: Tue, 22 Sep 2026 10:00:00 +0900",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: quoted-printable",
    ),
    qp(
        "안녕하세요.\n요청하신 이메일 인증 코드는 아래와 같습니다.\n\n인증 코드: 482913\n\n"
        "10분 안에 입력해 주세요. 링크로도 인증할 수 있습니다: "
        "https://svc.example.com/verify?code=482913&u=agent%2Bsignup\n".encode()
    ),
    CRLF,
)

# 2. EUC-KR + base64 본문 · EUC-KR 인코딩 제목 · EUC-KR 인코딩 표시 이름
write(
    "euckr-base64-verification.eml",
    headers(
        b"From: " + word("EUC-KR", "가상쇼핑".encode("euc_kr")) + b" <noreply@shop.example.co.kr>",
        "To: agent@atmark.ai",
        b"Subject: " + word("EUC-KR", "[가상쇼핑] 회원가입 인증번호 안내".encode("euc_kr")),
        "Message-ID: <20260922.735102@shop.example.co.kr>",
        "Date: Tue, 22 Sep 2026 10:05:00 +0900",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="euc-kr"',
        "Content-Transfer-Encoding: base64",
    ),
    b64("고객님, 가상쇼핑 회원가입을 환영합니다.\r\n회원가입 인증번호는 [735102] 입니다.\r\n".encode("euc_kr")),
    CRLF,
)

# 3. ks_c_5601-1987 (Outlook 라벨) + QP · CP949 확장 음절(똠·똘·햏 — KS X 1001 밖) + €(A2E6)
#    제목은 두 워드에 걸쳐 한 글자를 쪼갠다(메일 프로그램이 실제로 그렇게 접는다).
subject3 = "똠방각하 인증 요청".encode("cp949")
write(
    "ks-c-5601-qp.eml",
    headers(
        "From: Outlook User <user@corp.example.kr>",
        "To: agent@atmark.ai",
        b"Subject: " + word("ks_c_5601-1987", subject3[:3]) + b"\r\n " + word("ks_c_5601-1987", subject3[3:]),
        "Message-ID: <ks5601.001@corp.example.kr>",
        "Date: Tue, 22 Sep 2026 10:10:00 +0900",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="ks_c_5601-1987"',
        "Content-Transfer-Encoding: quoted-printable",
    ),
    qp("똠방각하 똘똘이님, 햏 인증코드 591046 을 입력하세요. 수수료 €5\n".encode("cp949")),
    CRLF,
)

# 4. 라벨 "cp949" — WHATWG 라벨이 아니다(TextDecoder 가 던진다). 코드 페이지 별칭으로 풀려야 한다.
write(
    "cp949-label.eml",
    headers(
        "From: noreply@bank.example.kr",
        "To: agent@atmark.ai",
        b"Subject: " + word("cp949", "본인확인 번호".encode("cp949")),
        "Message-ID: <cp949.001@bank.example.kr>",
        "Date: Tue, 22 Sep 2026 10:15:00 +0900",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=cp949",
        "Content-Transfer-Encoding: base64",
    ),
    b64("똠 본인확인 번호: 660371\r\n".encode("cp949")),
    CRLF,
)

# 5. ISO-2022-KR (RFC 1557) 7bit 본문 · ISO-2022-KR 인코딩 제목
write(
    "iso-2022-kr.eml",
    headers(
        "From: legacy@old.example.kr",
        "To: agent@atmark.ai",
        b"Subject: " + word("ISO-2022-KR", "인증 안내".encode("iso2022_kr")),
        "Message-ID: <iso2022kr.001@old.example.kr>",
        "Date: Tue, 22 Sep 2026 10:20:00 +0900",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=ISO-2022-KR",
        "Content-Transfer-Encoding: 7bit",
    ),
    "안녕하세요\r\n인증번호: 204817\r\n감사합니다\r\n".encode("iso2022_kr"),
)

# 6. HTML 만 · EUC-KR · base64 · <style>(head 와 body 양쪽)·<script>·주석·버튼 링크
html6 = "\n".join([
    "<!DOCTYPE html><html><head><title>TITLE-777777</title>",
    "<style>.code{color:#123456;font-size:32px}</style></head>",
    '<body><style>p{margin:0} .x{content:"888888"}</style>',
    '<script type="text/javascript">var otp = "000000";</script>',
    "<!-- 주석 999999 -->",
    '<table><tr><td>인증 코드</td><td><strong class="code">619274</strong></td></tr></table>',
    "<p>아래 버튼을 눌러 인증을 완료하세요.</p>",
    '<p><a href="https://game.example.com/verify?token=abc&amp;u=1" style="display:block">이메일 인증하기</a></p>',
    '<p>문의: <a href="mailto:help@game.example.com">help@game.example.com</a> &nbsp;&middot;&nbsp; &copy; 2026</p>',
    "</body></html>",
])
write(
    "html-only-euckr.eml",
    headers(
        b"From: " + word("euc-kr", "가상게임".encode("euc_kr")) + b" <account@game.example.com>",
        "To: agent@atmark.ai",
        "Subject: Verify your email",
        "Message-ID: <html-only.619274@game.example.com>",
        "Date: Tue, 22 Sep 2026 10:25:00 +0900",
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=euc-kr",
        "Content-Transfer-Encoding: base64",
    ),
    b64(html6.encode("euc_kr")),
    CRLF,
)

# 7. multipart/alternative — plain 은 안내문뿐, 코드는 HTML 에만
write(
    "alternative-placeholder.eml",
    headers(
        "From: no-reply@portal.example.kr",
        "To: agent@atmark.ai",
        b"Subject: " + word("UTF-8", "포털 가입 인증".encode()),
        "Message-ID: <alt.308455@portal.example.kr>",
        "Date: Tue, 22 Sep 2026 10:30:00 +0900",
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="ALT-BOUNDARY"',
    ),
    b"This is a multi-part message in MIME format.\r\n\r\n",
    b"--ALT-BOUNDARY\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n",
    b64("이 메일은 HTML 형식입니다. HTML 을 지원하는 메일 프로그램에서 확인해 주세요.".encode()), CRLF,
    b"--ALT-BOUNDARY\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n",
    b64("<div>가입 인증 코드는 <b>308455</b> 입니다.</div>".encode()), CRLF,
    b"--ALT-BOUNDARY--\r\n",
)

# 8. multipart/mixed + related — RFC 2231(UTF-8·EUC-KR·연속 파라미터)·RFC 2047 파일명·인라인 이미지
pdf = b"%PDF-1.4\n" + b"A" * 1015  # 1024 바이트
png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 56  # 64 바이트
write(
    "attachments-rfc2231.eml",
    headers(
        'From: "김담당" <manager@partner.example.com>',
        "To: agent@atmark.ai",
        "Subject: =?UTF-8?Q?=EA=B3=84=EC=95=BD_=EC=84=9C=EB=A5=98_=EC=86=A1=EB=B6=80?=",
        "Message-ID: <attach.001@partner.example.com>",
        "Date: Tue, 22 Sep 2026 11:00:00 +0900",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="MIX"',
    ),
    b'--MIX\r\nContent-Type: multipart/related; boundary="REL"\r\n\r\n',
    b"--REL\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n",
    b64("계약서와 견적서를 보내 드립니다.".encode()), CRLF,
    b"--REL\r\nContent-Type: image/png\r\nContent-ID: <logo001@partner.example.com>\r\n"
    b"Content-Disposition: inline\r\nContent-Transfer-Encoding: base64\r\n\r\n",
    b64(png), CRLF,
    b"--REL--\r\n",
    b"--MIX\r\nContent-Type: application/pdf\r\n"
    + ("Content-Disposition: attachment; filename*=UTF-8''%s\r\n" % pct("계약서.pdf".encode())).encode()
    + b"Content-Transfer-Encoding: base64\r\n\r\n",
    b64(pdf), CRLF,
    b"--MIX\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n"
    + ("Content-Disposition: attachment; filename*=EUC-KR''%s\r\n" % pct("견적서.xlsx".encode("euc_kr"))).encode()
    + b"Content-Transfer-Encoding: base64\r\n\r\n",
    b64(b"P" * 300), CRLF,
    b'--MIX\r\nContent-Type: text/plain; name="' + word("EUC-KR", "메모.txt".encode("euc_kr")) + b'"\r\n'
    b"Content-Disposition: attachment\r\nContent-Transfer-Encoding: base64\r\n\r\n",
    b64("첨부 메모".encode("euc_kr")), CRLF,
    b"--MIX\r\nContent-Type: application/octet-stream\r\n"
    + ("Content-Disposition: attachment; filename*0*=UTF-8''%s; filename*1*=%s\r\n"
       % (pct("한".encode()), pct("글.bin".encode()))).encode()
    + b"Content-Transfer-Encoding: base64\r\n\r\n",
    b64(b"\x01" * 10), CRLF,
    b"--MIX--\r\n",
)

# 9. 스레드 — In-Reply-To·접힌 References·그룹 문법·인코딩된 Cc 표시 이름·Reply-To
write(
    "thread-reply.eml",
    headers(
        "From: Partner <partner@ext.example.com>",
        b"To: " + word("UTF-8", "영업팀".encode()) + ': agent@atmark.ai, "홍길동" <hong@atmark.ai>;'.encode(),
        "Cc: =?UTF-8?Q?=EB=B0=95=EC=B0=B8=EC=A1=B0?= <cc@ext.example.com>, undisclosed-recipients:;",
        "Reply-To: replies+t42@ext.example.com",
        b"Subject: Re: Re: " + word("UTF-8", "견적 문의".encode()),
        "Message-ID: <turn3@ext.example.com>",
        "In-Reply-To: <turn2@atmark.ai>",
        "References: <turn1@ext.example.com>",
        " <turn2@atmark.ai>",
        "Date: Wed, 23 Sep 2026 09:00:00 +0000",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
    ),
    "세 번째 턴입니다.\r\n".encode(),
)
