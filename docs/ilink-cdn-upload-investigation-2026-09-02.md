# iLink CDN Upload Investigation (2026-09-02)

## Summary

Outbound iLink file uploads intermittently fail at the WeChat CDN upload step
with HTTP 500, an empty response body, no `x-error-message`, and no
`x-encrypted-param`. The failure occurs before `sendmessage` and is not caused
by the local outbox path check.

The behavior is size-sensitive but is not a strict size limit: uploads below
1 MiB can both succeed and fail. In this environment, 2 MiB and larger samples
failed consistently during the investigation.

## Official References

- Tencent plugin: https://github.com/Tencent/openclaw-weixin
- API documentation: https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md#backend-api-protocol
- CDN implementation: https://github.com/Tencent/openclaw-weixin/blob/main/src/cdn/cdn-upload.ts
- Related issues:
  - https://github.com/Tencent/openclaw-weixin/issues/149
  - https://github.com/Tencent/openclaw-weixin/issues/153
  - https://github.com/Tencent/openclaw-weixin/issues/172

The README describes the CDN transfer as `PUT`, while the v2.4.8 source uses
`POST`. Issue 172 also reports that `PUT` returns 404 and confirms that `POST`
is the implemented method.

## Protocol Path

1. Calculate plaintext size and MD5.
2. Generate a random file key and 16-byte AES key.
3. Encrypt with AES-128-ECB and PKCS#7 padding.
4. Call `POST ilink/bot/getuploadurl` with `media_type=3` for a file.
5. `POST` the ciphertext to `upload_full_url` as
   `application/octet-stream`.
6. Read `x-encrypted-param` from the CDN response.
7. Put that value in `file_item.media.encrypt_query_param` and call
   `ilink/bot/sendmessage` with item type 4.

The official v2.4.8 request includes these headers in addition to bearer auth:

- `AuthorizationType: ilink_bot_token`
- `X-WECHAT-UIN: <base64 decimal uint32>`
- `iLink-App-Id: bot`
- `iLink-App-ClientVersion: 132104`

Its `base_info` contains `channel_version=2.4.8` and `bot_agent=OpenClaw`.

## Live Results

The official request headers and `base_info` were reproduced directly against
the active account. `getuploadurl` returned HTTP 200 and a valid
`upload_full_url` containing `encrypted_query_param`, `filekey`, and `taskid`.
The following CDN results were then observed:

| Plaintext size | Result |
| ---: | :--- |
| 4 bytes | 200 with `x-encrypted-param` |
| 64 KiB | 200 with `x-encrypted-param` |
| 256 KiB | 500 |
| 409 KiB | 500 |
| 512 KiB | 200 with `x-encrypted-param` |
| 600 KiB | 200 with `x-encrypted-param` |
| 768 KiB | 500 |
| 900 KiB | 200 with `x-encrypted-param` |
| 1 MiB | repeated 500 responses |
| 2 MiB | two independent URLs returned 500 |
| 5 MiB | 500 |
| 18.9 MiB PDF | repeated 500 responses |

A single 1 MiB presigned URL was retried against different resolved CDN IPs;
both attempts returned 500. Some failures closed the connection while the
request body was still being written, producing a local `EPIPE` after the HTTP
500 response.

## Conclusions

- `POST` is correct despite the README wording.
- AES padding, MD5, media type, file key, and URL construction match the
  official implementation.
- Adding the official app ID, client version, channel version, and bot agent
  does not resolve the CDN 500 response.
- The configured `FILE_SEND_MAX_BYTES=50 MiB` is a local admission limit, not a
  demonstrated iLink CDN capability.
- The mixed results below 1 MiB rule out a simple hard cutoff. Larger payloads
  nevertheless have a substantially worse observed success rate.
- The practical failure is currently upstream of `sendmessage`, in the CDN
  upload operation or its presigned upload task.

## Follow-up Guidance

- Log the safe response fields: HTTP status, `x-error-message` presence,
  response byte count, plaintext/ciphertext sizes, attempt number, and a hash
  of the presigned URL. Never log the URL or auth/context tokens.
- On CDN 5xx, use bounded backoff and consider requesting a fresh presigned URL
  rather than only retrying the same URL.
- Do not present the 50 MiB local setting as a guaranteed WeChat limit.
- Route larger artifacts to external storage until the iLink CDN behavior is
  documented or stabilized.
