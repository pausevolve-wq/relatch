Fixes unlimited anonymous token minting by adding IP-based rate limiting to the /api/anon-token endpoint.

- Limits each IP to 5 anonymous tokens per hour.
- Uses Redis to track IP-based token issuance with a sliding window (key expiry).
- Fail-closed: if Redis is unavailable, the endpoint returns 503 to avoid issuing unbounded tokens.
- Logs rate-limit events to Axiom for monitoring.

This change prevents attackers from exhausting the Gemini generation quota by minting thousands of anonymous tokens. The per-token call limit (5 calls) in enrich.js/ocr.js remains unchanged and continues to bound usage per token.

No changes to enrich.js or ocr.js are required; they already validate tokens and enforce the per-token call limit.

Tested locally: verified that after 5 tokens from the same IP, further requests return 429.