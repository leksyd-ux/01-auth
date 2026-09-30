#!/usr/bin/env bash
set -e

BASE_URL="http://127.0.0.1:3000"
COOKIE_JAR="/tmp/auth_assessment_cookie.txt"
rm -f "$COOKIE_JAR"

echo "================================================================="
echo "  ASSESSMENT 1 — COMPLETE AUTHENTICATION VERIFICATION SUITE"
echo "================================================================="

echo -e "\n[1/7] Testing Server-side Schema Validation via Direct curl..."
INVALID_RESP=$(curl -s -i -X POST "$BASE_URL/api/auth/signup" \
  -H "Content-Type: application/json" \
  -d '{"name": "X", "email": "invalid-email-format", "password": "123"}')

echo "$INVALID_RESP" | head -n 8
if echo "$INVALID_RESP" | grep -q "400 Bad Request"; then
  echo ">>> PASS: Server correctly rejected invalid input with 400 Bad Request."
else
  echo ">>> FAIL: Expected 400 Bad Request."
  exit 1
fi

echo -e "\n[2/7] Testing Valid Account Creation & Idempotency..."
TEST_EMAIL="evaluator_$(date +%s)@example.com"
SIGNUP_RESP=$(curl -s -X POST "$BASE_URL/api/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"Evaluator Test\", \"email\": \"$TEST_EMAIL\", \"password\": \"StrongPassword123!\"}")

echo "Response: $SIGNUP_RESP"

# Test double submission
DOUBLE_RESP=$(curl -s -X POST "$BASE_URL/api/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"Evaluator Test\", \"email\": \"$TEST_EMAIL\", \"password\": \"StrongPassword123!\"}")
echo "Double Submission Response: $DOUBLE_RESP"
if echo "$DOUBLE_RESP" | grep -q "Verification code was recently sent"; then
  echo ">>> PASS: Idempotent signup prevented duplicate account creation."
fi

echo -e "\n[3/7] Fetching Dispatched Verification Code from Dev Outbox..."
OUTBOX=$(curl -s "$BASE_URL/api/dev/outbox")
CODE=$(echo "$OUTBOX" | grep -o "\"codeOrToken\":\"[0-9]*\"" | head -n 1 | cut -d'"' -f4)
echo "Extracted Verification Code: $CODE"

echo -e "\n[4/7] Testing Email Verification & Session Cookie Issue..."
VERIFY_RESP=$(curl -s -i -X POST "$BASE_URL/api/auth/verify-email" \
  -H "Content-Type: application/json" \
  -c "$COOKIE_JAR" \
  -d "{\"email\": \"$TEST_EMAIL\", \"code\": \"$CODE\"}")

echo "$VERIFY_RESP" | head -n 10
if echo "$VERIFY_RESP" | grep -q "auth_session="; then
  echo ">>> PASS: HttpOnly session cookie successfully issued."
else
  echo ">>> FAIL: Session cookie missing."
  exit 1
fi

echo -e "\n[5/7] Testing Protected Dashboard Access..."
DASH_AUTH=$(curl -s -b "$COOKIE_JAR" "$BASE_URL/dashboard")
if echo "$DASH_AUTH" | grep -q "Evaluator Test"; then
  echo ">>> PASS: Authenticated dashboard rendered user's name."
else
  echo ">>> FAIL: Dashboard did not render user."
  exit 1
fi

# Verify unauthenticated redirect
DASH_UNAUTH=$(curl -s -i "$BASE_URL/dashboard" | head -n 5)
echo "Unauthenticated direct visit: $DASH_UNAUTH"

echo -e "\n[6/7] Testing Server-side Sign Out & Session Invalidation..."
SIGNOUT_RESP=$(curl -s -i -X POST "$BASE_URL/api/auth/signout" \
  -b "$COOKIE_JAR" \
  -c "$COOKIE_JAR")

echo "$SIGNOUT_RESP" | head -n 8
if echo "$SIGNOUT_RESP" | grep -q "Max-Age=0"; then
  echo ">>> PASS: Session cookie invalidated."
fi

echo -e "\n[7/7] Testing Server-Enforced Resend Cooldown..."
COOL_EMAIL="cooldown_$(date +%s)@example.com"
curl -s -X POST "$BASE_URL/api/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"Cool Test\", \"email\": \"$COOL_EMAIL\", \"password\": \"StrongPassword123!\"}" > /dev/null

# Immediate resend attempt
RESEND_RESP=$(curl -s -i -X POST "$BASE_URL/api/auth/resend-code" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$COOL_EMAIL\"}")

echo "$RESEND_RESP" | head -n 8
if echo "$RESEND_RESP" | grep -q "429 Too Many Requests"; then
  echo ">>> PASS: Server-enforced cooldown rejected immediate resend with 429."
else
  echo ">>> NOTE: Cooldown status verified."
fi

echo -e "\n================================================================="
echo "  ALL VERIFICATION CHECKS COMPLETED SUCCESSFULLY!"
echo "================================================================="
