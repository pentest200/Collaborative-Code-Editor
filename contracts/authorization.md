# Authorization contract (frozen for Phase 00)

GitHub.com OAuth authorization code flow uses one use random state, PKCE S256 and exact configured callback. The Go server exchanges code, requests only login identity scope, discards unused provider tokens, and issues a random application session. PostgreSQL stores a hash of the session token, expiry and revocation. Production cookies are Secure, HttpOnly and SameSite. Mutating cookie requests require explicit CSRF/origin validation. Browser localStorage and WebSocket query strings never hold long lived credentials.

| Action | Owner | Editor | Viewer |
|---|---|---|---|
| Read active source, history, search, presence | yes | yes | yes |
| Submit any content update, including reconnect delta | yes | yes | no |
| Create/rename/move/delete files; create checkpoint; run | yes | yes | no |
| Manage invitations/members; restore checkpoint; delete project | yes | no | no |

Invites grant editor/viewer only, use hashed high entropy tokens, expiry and bounded use count. Acceptance requires authenticated user and transactional use count. Role/member changes are persistent metadata operations. No client selected role is trusted.

Every append transaction rechecks session, project membership, active project/file/document generation, and valid worker fence. An append that commits before a removal transaction is valid; no append committing after removal may use a cached role. Use consistent lock order: `projects → project_members/sessions → files → documents → document_owners` for writes, and acquire rows in stable UUID order within a class. Metadata events trigger prompt disconnect; readers are revalidated every 2 seconds. Data already delivered to a browser cannot be erased.

Go checks Origin/session/project/document on upgrade and signs a short lived scoped assertion for the private worker. Worker verifies issuer/audience/signature/expiry and consumes the connection ID once. The assertion does not replace current authorization checks on writes. Internal collaboration and runner control are private, authenticated surfaces. Viewer denials must be exercised with raw frames.

Phase 08 clarifies the implemented lock order: project → session → membership →
file → document → owner, as frozen in persistence.md. Current-session and invite
expiry checks after project-lock waits use database clock_timestamp(), rather than
the transaction-start timestamp. Search reads take project/session/membership
locks, filter current generations and recheck file identity before snippets.
See search.md and docs/phase08-review.md for the specific barriers and review scope.
