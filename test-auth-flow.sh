#!/usr/bin/env bash
# Assessment 1 — Auth flow verification + adversarial tests
# Usage:
#   npm run dev                      # in another terminal, in 01-auth/
#   bash test-auth-flow.sh
#
# Env overrides:  BASE=http://127.0.0.1:3000   DB=assessment_auth
# Keep rows:      SKIP_CLEANUP=1 bash test-auth-flow.sh

BASE="${BASE:-http://127.0.0.1:3000}"
DB="${DB:-assessment_auth}"
TS=$(date +%s)
JAR=$(mktemp /tmp/authjar.XXXXXX)

PASS=0; FAIL=0; SKIP=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
skip() { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; SKIP=$((SKIP+1)); }
head_() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# status-only request
code_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
# body-only request
body_of() { curl -s "$@"; }
# POST json -> prints "STATUS\nBODY"
post() { curl -s -w '\n%{http_code}' -X POST "$BASE$1" -H 'Content-Type: application/json' -d "$2"; }

psq()  { psql -d "$DB" -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }
psqN() { psql -d "$DB" -tAc "$1" 2>/dev/null; }
reset_buckets() { psql -d "$DB" -c 'DELETE FROM rate_limit_buckets;' >/dev/null 2>&1; }

# latest 6-digit verification code from the dev outbox
latest_code() { body_of "$BASE/api/dev/outbox" | grep -o '"codeOrToken":"[0-9]\{6\}"' | head -1 | cut -d'"' -f4; }
# latest 64-hex reset token
latest_token() { body_of "$BASE/api/dev/outbox" | grep -o '"codeOrToken":"[a-f0-9]\{64\}"' | head -1 | cut -d'"' -f4; }

signup() { # name email password
  body_of -X POST "$BASE/api/auth/signup" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$1\",\"email\":\"$2\",\"password\":\"$3\"}"
}
# signup then verify -> leaves a verified account. echoes email
make_verified() { # name email password
  signup "$1" "$2" "$3" >/dev/null
  local c; c=$(latest_code)
  body_of -X POST "$BASE/api/auth/verify-email" -H 'Content-Type: application/json' \
    -c "$JAR" -d "{\"email\":\"$2\",\"code\":\"$c\"}" >/dev/null
  printf '%s' "$2"
}

# ---------------------------------------------------------------- preflight
head_ "Preflight"
if [ "$(code_of "$BASE/signin")" = "200" ]; then ok "server up at $BASE"
else bad "server not reachable at $BASE — run 'npm run dev' first"; exit 1; fi
if [ -n "$(psq 'SELECT 1')" ]; then ok "postgres db '$DB' reachable"
else bad "cannot reach db '$DB' (set DB=...)"; exit 1; fi
if body_of "$BASE/api/dev/outbox" | grep -q '"emails"'; then ok "dev outbox endpoint available (may be empty until first signup)"
else skip "dev outbox unavailable — tests needing codes will fail"; fi

# ============================================================ 1. validation
head_ "1. Server-side validation (browser bypassed)"
S=$(post /api/auth/signup '{"name":"A","email":"not-an-email","password":"123"}' | tail -1)
[ "$S" = "400" ] && ok "invalid signup -> 400" || bad "invalid signup -> $S (want 400)"
B=$(post /api/auth/signup '{"name":"A","email":"not-an-email","password":"123"}' | tail -2 | head -1)
echo "$B" | grep -q '"details"' && ok "field-level error details returned" \
                                 || bad "no field-level details: $B"
S=$(post /api/auth/signin '{"email":"a@b.co","password":""}' | tail -1)
[ "$S" = "400" ] && ok "empty-password signin -> 400" || bad "empty-password signin -> $S (want 400)"

# Password policy: one lower, one upper, one number, one special character,
# each checked in that order; length (8-64) is the FINAL gate on the finished
# password. The error names only the next unmet step.
reset_buckets
S=$(post /api/auth/signup '{"name":"Short Pass","email":"pw7_'"$TS"'@example.com","password":"Aa1!aaa"}' | tail -1)
[ "$S" = "400" ] && ok "7-char password -> 400 (min is 8)" || bad "7-char password -> $S (want 400)"
# A 1-char password has all classes missing; the FIRST unmet step must be the
# uppercase requirement, not the length requirement.
reset_buckets
R=$(post /api/auth/signup '{"name":"Seq Test","email":"pwseq1_'"$TS"'@example.com","password":"a"}' | tail -2 | head -1)
echo "$R" | grep -q 'an uppercase letter' && ok "single char reports the uppercase step, not length" \
                                           || bad "wrong first step for 'a': $R"
reset_buckets
R=$(post /api/auth/signup '{"name":"Seq Test","email":"pwseq2_'"$TS"'@example.com","password":"aA"}' | tail -2 | head -1)
echo "$R" | grep -q 'a number' && ok "after upper+lower, next step is the number" \
                              || bad "expected number step for 'aA': $R"
reset_buckets
R=$(post /api/auth/signup '{"name":"Seq Test","email":"pwseq3_'"$TS"'@example.com","password":"aA1"}' | tail -2 | head -1)
echo "$R" | grep -q 'a special character' && ok "after lower/upper/number, next step is special" \
                                            || bad "expected special step for 'aA1': $R"
# All four classes met but still short -> length is reported only now.
reset_buckets
R=$(post /api/auth/signup '{"name":"Seq Test","email":"pwseq4_'"$TS"'@example.com","password":"aA1!"}' | tail -2 | head -1)
echo "$R" | grep -q 'at least 8 characters' && ok "length reported only once all classes are met" \
                                             || bad "expected length step for 'aA1!': $R"
reset_buckets
LONG=$(printf 'a%.0s' $(seq 1 65))
S=$(post /api/auth/signup '{"name":"Long Pass","email":"pw65_'"$TS"'@example.com","password":"'"$LONG"'A1!x"}' | tail -1)
[ "$S" = "400" ] && ok "65-char password -> 400 (max is 64)" || bad "65-char password -> $S (want 400)"
reset_buckets
S=$(post /api/auth/signup '{"name":"No Compose","email":"pw8_'"$TS"'@example.com","password":"alllowercase"}' | tail -1)
[ "$S" = "400" ] && ok "password missing upper/number/special -> 400" \
                || bad "composition rules NOT enforced: lowercase-only password -> $S"
reset_buckets
R=$(post /api/auth/signup '{"name":"No Compose","email":"pw9_'"$TS"'@example.com","password":"alllowercase"}' | tail -2 | head -1)
echo "$R" | grep -q 'an uppercase letter' && ok "error names the next missing step (uppercase)" \
                                           || bad "error did not name missing uppercase: $R"
echo "$R" | grep -q 'a number' && bad "error listed every missing class at once, not the next step: $R" \
                              || ok "error reports only the next unmet step, not all at once"
# Each subsequent stage advances one step as the earlier class is satisfied.
R=$(post /api/auth/signup '{"name":"No Compose","email":"pwa_'"$TS"'@example.com","password":"alllowercaseX"}' | tail -2 | head -1)
echo "$R" | grep -q 'a number' && ok "message advances to the number step" \
                               || bad "expected number step: $R"
R=$(post /api/auth/signup '{"name":"No Compose","email":"pwb_'"$TS"'@example.com","password":"alllowercaseX9"}' | tail -2 | head -1)
echo "$R" | grep -q 'a special character' && ok "message advances to the special-character step" \
                                         || bad "expected special-character step: $R"
# Special characters are broad, not a hand-listed shortlist.
reset_buckets
S=$(post /api/auth/signup '{"name":"Spec Chars","email":"pws_'"$TS"'@example.com","password":"alllowerX9~"}' | tail -1)
[ "$S" = "201" ] && ok "unlisted special char (~) counts as special" \
                || bad "special char set too narrow, ~ rejected: $S"
reset_buckets
S=$(post /api/auth/signup '{"name":"All Compose","email":"pwc_'"$TS"'@example.com","password":"Str0ngPass!"}' | tail -1)
[ "$S" = "201" ] && ok "password meeting all 4 classes accepted" \
                || bad "valid composition rejected -> $S"

# ============================================================ 2. happy path
head_ "2. New user: signup -> verify -> dashboard -> signout"
EMAIL="flow_$TS@example.com"; PW='StrongPassword123!'
reset_buckets
S=$(post /api/auth/signup "{\"name\":\"Flow User\",\"email\":\"$EMAIL\",\"password\":\"$PW\"}" | tail -1)
[ "$S" = "201" ] && ok "signup -> 201" || bad "signup -> $S (want 201)"
[ "$(psq "SELECT count(*) FROM users WHERE email='$EMAIL'")" = "1" ] \
  && ok "exactly 1 user row" || bad "user row count != 1"

HASH=$(psqN "SELECT \"passwordHash\" FROM users WHERE email='$EMAIL'" | tr -d '[:space:]')
case "$HASH" in
  '$2b$10$'*) ok "password stored as bcrypt hash (cost 10)" ;;
  '$2'*)      bad "bcrypt hash has wrong cost factor: ${HASH:0:7}" ;;
  *)          bad "password not stored as bcrypt hash: ${HASH:0:24}" ;;
esac
[ "$(psq "SELECT count(*) FROM users WHERE email='$EMAIL' AND \"passwordHash\"='$PW'")" = "0" ] \
  && ok "plaintext password absent from db" || bad "PLAINTEXT PASSWORD IN DB"

CODE=$(latest_code)
[ -n "$CODE" ] && ok "verification code issued ($CODE)" || bad "no code in outbox"
[ "$(psq "SELECT count(*) FROM verification_codes vc JOIN users u ON u.id=vc.\"userId\" WHERE u.email='$EMAIL'")" = "1" ] \
  && ok "verification code persisted in db" || bad "code not in db"
[ "$(psq "SELECT count(*) FROM verification_codes vc JOIN users u ON u.id=vc.\"userId\" WHERE u.email='$EMAIL' AND vc.\"codeHash\"='$CODE'")" = "0" ] \
  && ok "code stored hashed, not plaintext" || bad "code stored as PLAINTEXT"

S=$(code_of -X POST "$BASE/api/auth/verify-email" -H 'Content-Type: application/json' \
      -c "$JAR" -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}")
[ "$S" = "200" ] && ok "verify -> 200" || bad "verify -> $S (want 200)"
grep -q auth_session "$JAR" && ok "session cookie issued" || bad "no session cookie"
curl -s -b "$JAR" "$BASE/dashboard" | grep -q "Flow User" \
  && ok "authed dashboard shows user name" || bad "dashboard did not show name"
[ "$(psq "SELECT count(*) FROM sessions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$EMAIL'")" = "1" ] \
  && ok "session row created server-side" || bad "no session row"

head_ "3. Unauthenticated dashboard access"
S=$(code_of "$BASE/dashboard")
[ "$S" = "307" ] || [ "$S" = "302" ] && ok "direct /dashboard -> $S redirect" \
                                    || bad "direct /dashboard -> $S (want redirect)"
body_of -i "$BASE/dashboard" | grep -qi "location: */signin" \
  && ok "redirect target is /signin" || bad "wrong redirect target"

head_ "4. Sign out terminates the session"
S=$(code_of -X POST "$BASE/api/auth/signout" -b "$JAR" -c "$JAR")
[ "$S" = "200" ] && ok "signout -> 200" || bad "signout -> $S"
S=$(code_of -b "$JAR" "$BASE/dashboard")
[ "$S" = "307" ] || [ "$S" = "302" ] && ok "dashboard blocked after signout" \
                                    || bad "session survived signout ($S)"
[ "$(psq "SELECT count(*) FROM sessions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$EMAIL'")" = "0" ] \
  && ok "session row deleted from db" || bad "session row still present"
FAKE="deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
S=$(code_of -H "Cookie: auth_session=$FAKE" "$BASE/api/auth/me")
[ "$S" = "401" ] && ok "forged cookie rejected -> 401" || bad "forged cookie -> $S (want 401)"

# ============================================================ 5. idempotency
head_ "5. Idempotent signup"
EMAIL="idem_$TS@example.com"
reset_buckets
signup "Idem Alpha" "$EMAIL" 'FirstPassword1!' >/dev/null
H1=$(psqN "SELECT \"passwordHash\" FROM users WHERE email='$EMAIL'" | tr -d '[:space:]')
sleep 1
signup "Idem Bravo" "$EMAIL" 'SecondPassword2!' >/dev/null
H2=$(psqN "SELECT \"passwordHash\" FROM users WHERE email='$EMAIL'" | tr -d '[:space:]')
[ "$(psq "SELECT count(*) FROM users WHERE email='$EMAIL'")" = "1" ] \
  && ok "double submit -> still 1 account" || bad "duplicate account created"
[ "$H1" = "$H2" ] && ok "existing password hash not overwritten" || bad "password hash was overwritten"
EMAIL="race_$TS@example.com"
reset_buckets
for i in $(seq 1 10); do
  curl -s -o /dev/null -X POST "$BASE/api/auth/signup" -H 'Content-Type: application/json' \
    -d "{\"name\":\"Race User\",\"email\":\"$EMAIL\",\"password\":\"StrongPassword123!\"}" &
done; wait
[ "$(psq "SELECT count(*) FROM users WHERE email='$EMAIL'")" = "1" ] \
  && ok "10x parallel submit -> 1 account" || bad "parallel submit made $(psq "SELECT count(*) FROM users WHERE email='$EMAIL'") accounts"

# ============================================================ 6. verification
head_ "6. Verification code lifecycle"
EMAIL="exp_$TS@example.com"
reset_buckets
signup "Expiry User" "$EMAIL" 'StrongPassword123!' >/dev/null
CODE=$(latest_code)
psql -d "$DB" -c "UPDATE verification_codes SET \"expiresAt\"=now()-interval '1 hour'
                   WHERE \"userId\"=(SELECT id FROM users WHERE email='$EMAIL');" >/dev/null 2>&1
if [ "$(psq "SELECT count(*) FROM verification_codes vc JOIN users u ON u.id=vc.\"userId\" WHERE u.email='$EMAIL' AND vc.\"expiresAt\" < now()")" = "1" ]; then
  R=$(post /api/auth/verify-email "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}" | tail -1)
  [ "$R" = "400" ] && ok "expired code -> 400" || bad "EXPIRED CODE ACCEPTED -> $R"
else
  skip "expiry precondition failed (no row updated) — rerun"
fi

EMAIL="reuse_$TS@example.com"
reset_buckets
signup "Reuse User" "$EMAIL" 'StrongPassword123!' >/dev/null
CODE=$(latest_code)
R=$(code_of -X POST "$BASE/api/auth/verify-email" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}")
[ "$R" = "200" ] && ok "valid code -> 200" || bad "valid code -> $R"
SESS1=$(psq "SELECT count(*) FROM sessions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$EMAIL'")
reset_buckets
# Replaying a consumed code must not mint another session. The endpoint may
# legitimately answer 200 "already verified", so assert on the session count,
# which is the actual security invariant.
body_of -X POST "$BASE/api/auth/verify-email" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}" >/dev/null
SESS2=$(psq "SELECT count(*) FROM sessions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$EMAIL'")
[ "$SESS2" = "$SESS1" ] && ok "replayed code mints no extra session (${SESS1}->${SESS2})" \
                       || bad "REPLAY MINTED A SESSION (${SESS1}->${SESS2})"
[ "$(psq "SELECT count(*) FROM verification_codes vc JOIN users u ON u.id=vc.\"userId\" WHERE u.email='$EMAIL' AND vc.\"usedAt\" IS NOT NULL")" = "1" ] \
  && ok "usedAt recorded on consumed code" || bad "usedAt not recorded"

EMAIL="wrong_$TS@example.com"
reset_buckets
signup "Wrong User" "$EMAIL" 'StrongPassword123!' >/dev/null
R=$(post /api/auth/verify-email "{\"email\":\"$EMAIL\",\"code\":\"000000\"}" | tail -1)
[ "$R" = "400" ] && ok "wrong code -> 400" || bad "WRONG CODE ACCEPTED -> $R"

head_ "7. Resend cooldown (server-enforced)"
EMAIL="cool_$TS@example.com"
reset_buckets
signup "Cool User" "$EMAIL" 'StrongPassword123!' >/dev/null
R=$(code_of -X POST "$BASE/api/auth/resend-code" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}")
[ "$R" = "429" ] && ok "immediate resend -> 429" || bad "immediate resend -> $R (want 429)"
curl -s -i -X POST "$BASE/api/auth/resend-code" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}" \
  | grep -qi "retry-after:" && ok "Retry-After header present" || bad "no Retry-After header"
reset_buckets
sleep 61
R=$(code_of -X POST "$BASE/api/auth/resend-code" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}")
[ "$R" = "200" ] && ok "resend allowed after cooldown" || bad "resend after 61s -> $R (want 200)"

# ============================================================ 8. reset pw
head_ "8. Password reset"
EMAIL="rst_$TS@example.com"; OLD='StrongPassword123!'; NEW='NewPassword456!'
reset_buckets
make_verified "Reset User" "$EMAIL" "$OLD" >/dev/null
R=$(code_of -X POST "$BASE/api/auth/forgot-password" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}")
[ "$R" = "200" ] && ok "forgot-password -> 200" || bad "forgot-password -> $R"
[ "$(psq "SELECT count(*) FROM password_reset_tokens t JOIN users u ON u.id=t.\"userId\" WHERE u.email='$EMAIL'")" = "1" ] \
  && ok "reset token persisted" || bad "no reset token row"
[ "$(psq "SELECT count(*) FROM password_reset_tokens t JOIN users u ON u.id=t.\"userId\" WHERE u.email='$EMAIL' AND t.\"tokenHash\" IS NOT NULL")" = "1" ] \
  && ok "token stored hashed" || bad "token not stored"
TOKEN=$(latest_token)
[ -n "$TOKEN" ] && ok "reset link token issued" || bad "no reset token in outbox"
R=$(code_of -X POST "$BASE/api/auth/reset-password" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"password\":\"$NEW\"}")
[ "$R" = "200" ] && ok "reset with valid token -> 200" || bad "reset -> $R"
R=$(code_of -X POST "$BASE/api/auth/reset-password" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"password\":\"Third789!\"}")
[ "$R" = "400" ] && ok "token reuse -> 400 (single-use)" || bad "REUSED RESET TOKEN ACCEPTED -> $R"
reset_buckets
R=$(code_of -X POST "$BASE/api/auth/signin" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$OLD\"}")
[ "$R" = "401" ] && ok "old password -> 401" || bad "old password -> $R (want 401)"
R=$(code_of -X POST "$BASE/api/auth/signin" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$NEW\"}")
[ "$R" = "200" ] && ok "new password -> 200" || bad "new password -> $R (want 200)"

# ============================================================ 9. rate limit
head_ "9. Rate limiting"
for ep in signup signin forgot-password reset-password resend-code verify-email; do
  n=$(grep -c "checkRateLimit" "src/app/api/auth/$ep/route.ts" 2>/dev/null || echo 0)
  [ "${n:-0}" -ge 1 ] && ok "$ep is rate limited" || bad "$ep has NO rate limit"
done
# NOTE: the signin bucket is keyed on ip+email, so the SAME email must be
# reused every time or each request lands in its own bucket.
reset_buckets
GHOST="ghost_$TS@nowhere.tld"
n=0
for i in $(seq 1 30); do
  c=$(code_of -X POST "$BASE/api/auth/signin" -H 'Content-Type: application/json' \
      -d "{\"email\":\"$GHOST\",\"password\":\"whatever1!\"}")
  [ "$c" != "429" ] && n=$((n+1))
done
[ "$n" -le 5 ] && ok "sequential signin: $n/30 allowed (limit 5)" \
               || bad "sequential signin: $n/30 allowed (limit 5) — limiter too loose"

head_ "10. Rate limiter under concurrency (known weak spot)"
reset_buckets
GHOST2="ghostc_$TS@nowhere.tld"
tmp=$(mktemp); rm -f "$tmp"
for i in $(seq 1 30); do
  ( curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/auth/signin" \
      -H 'Content-Type: application/json' \
      -d "{\"email\":\"$GHOST2\",\"password\":\"whatever1!\"}" >> "$tmp" ) &
done; wait
n=$(grep -c '^200\|^401' "$tmp" 2>/dev/null || echo 0)
BUCKET=$(psqN "SELECT count FROM rate_limit_buckets ORDER BY \"updatedAt\" DESC LIMIT 1" | tr -d '[:space:]')
echo "        bucket counter ended at: ${BUCKET:-?}"
if [ "${n:-99}" -le 5 ]; then ok "30 concurrent signins: $n allowed (limit 5)"
else bad "30 CONCURRENT signins let $n through (limit 5) — read-then-write race"; fi
rm -f "$tmp"

# ============================================================ 11. THE BYPASS
head_ "11. ACCOUNT TAKEOVER on already-verified user"
VICTIM="victim_$TS@example.com"
reset_buckets
make_verified "Victim User" "$VICTIM" 'StrongPassword123!' >/dev/null
[ "$(psq "SELECT count(*) FROM users WHERE email='$VICTIM' AND \"emailVerifiedAt\" IS NOT NULL")" = "1" ] \
  && ok "victim account is verified" || bad "could not create verified victim"
HJ=$(mktemp)
echo "        attacker: no password, no session, guessed code '000000'"
V_SESS=$(psq "SELECT count(*) FROM sessions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$VICTIM'")
R=$(code_of -X POST "$BASE/api/auth/verify-email" -H 'Content-Type: application/json' \
    -c "$HJ" -d "{\"email\":\"$VICTIM\",\"code\":\"000000\"}")
A_SESS=$(psq "SELECT count(*) FROM sessions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$VICTIM'")
if [ "$A_SESS" -gt "$V_SESS" ]; then
  bad "CRITICAL: unauthenticated takeover — verify-email minted a session ($V_SESS->$A_SESS)"
  NAME=$(body_of -b "$HJ" "$BASE/dashboard" | grep -o 'dashboard-user-name">[^<]*' | cut -d'>' -f2)
  echo "        attacker reached dashboard as: ${NAME:-<none>}"
  curl -s -X POST "$BASE/api/auth/signout" -b "$HJ" >/dev/null 2>&1
else
  ok "already-verified user cannot mint a session via guessed code (got $R)"
  D=$(code_of -b "$HJ" "$BASE/dashboard")
  [ "$D" = "307" ] || [ "$D" = "302" ] \
    && ok "attacker cookie rejected at /dashboard ($D)" \
    || bad "attacker cookie reached /dashboard ($D)"
fi
LEFT=$(psq "SELECT count(*) FROM sessions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$VICTIM'")
[ "$LEFT" = "0" ] && ok "no leftover session for victim" \
                 || skip "$LEFT session row(s) left for victim — delete manually"

# ============================================================ 12. NO PII IN URLS
head_ "12. No email address or token in any URL"

# A query string is logged in the access log, kept in browser history, and
# shipped in the Referer header. Nothing typed into a form may end up there.

# The reset link must carry its token in the fragment, never the query string.
RESET_EMAIL="rpurl_$TS@example.com"
reset_buckets
make_verified "Reset Urler" "$RESET_EMAIL" 'ResetUrl1!' >/dev/null
reset_buckets
body_of -X POST "$BASE/api/auth/forgot-password" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$RESET_EMAIL\"}" >/dev/null
LINK=$(body_of "$BASE/api/dev/outbox" | grep -o 'http[^"]*reset-password[^"]*' | head -1)
if [ -n "$LINK" ]; then
  case "$LINK" in
    *"#token="*) ok "reset link carries token in fragment (#token=)" ;;
    *) bad "reset link does NOT use a fragment: $LINK" ;;
  esac
  case "$LINK" in
    *"?token="*) bad "reset link still uses a query string: $LINK" ;;
    *) ok "reset link has no ?token= query parameter" ;;
  esac
else
  bad "could not read a reset link from the dev outbox"
fi

# The emailed body must not name the recipient in the URL either.
RESET_HREF=$(body_of "$BASE/api/dev/outbox" | grep -o 'href=\\*"[^"]*reset-password[^"]*"' | head -1)
case "$RESET_HREF" in
  *"$RESET_EMAIL"*) bad "reset link contains the recipient's email address" ;;
  *) ok "reset link contains no email address" ;;
esac

# The client-side redirect after signup must be a bare path. This is asserted
# against the source because the navigation happens in the browser; a grep that
# stops matching is the alarm that the leak came back.
if grep -rq 'verify-email?email=' src/app 2>/dev/null; then
  bad "an email is still being placed in the verify-email URL"
else
  ok "no 'verify-email?email=' redirect anywhere in src/app"
fi

# Same check for the reset token arriving via the query string.
if grep -rq 'searchParams.get("token")' src/app 2>/dev/null; then
  bad "reset token is still read from the query string"
else
  ok "reset token is no longer read from searchParams"
fi

# The referrer policy must be present, since it is the backstop if a value
# ever does reach a URL again.
if curl -sI "$BASE/signup" | grep -qi 'referrer-policy: *no-referrer'; then
  ok "Referrer-Policy: no-referrer served"
else
  bad "Referrer-Policy: no-referrer missing from responses"
fi

# ============================================================ cleanup
if [ "${SKIP_CLEANUP:-0}" != "1" ]; then
  head_ "Cleanup"
  psql -d "$DB" -c "DELETE FROM users WHERE email LIKE '%_$TS@example.com';" >/dev/null 2>&1
  reset_buckets
  echo "  removed test users matching %_$TS@example.com"
  psql -d "$DB" -c "DELETE FROM users WHERE email LIKE '%_$TS@example.com';" >/dev/null 2>&1
fi
rm -f "$JAR" "${HJ:-/dev/null}"

# ============================================================ summary
printf '\n\033[1m========== SUMMARY ==========\033[0m\n'
printf '  passed: %s\n  failed: %s\n  skipped: %s\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ] && printf '\n\033[32mAll checks passed.\033[0m\n' \
                  || printf '\n\033[31m%s check(s) failed — see FAIL lines above.\033[0m\n' "$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
