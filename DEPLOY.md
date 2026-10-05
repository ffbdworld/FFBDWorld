# FFBDWorld API deployment

This package uses the `/v1/*` API used by the connected FFBDWorld Admin Panel and the optional Website API bridge.

Required environment variables:
- FIREBASE_PROJECT_ID=bondhubd-e6fb4
- FIREBASE_SERVICE_ACCOUNT_JSON=<server-side Firebase service account JSON>
- CORS_ORIGINS=https://your-real-ffbdworld-domain.example
- PORT=8080

Do NOT put the Firebase service-account private key into the HTML file, APK, Git repository, or chat.

Health endpoint: `/health`
Admin authentication: `/v1/auth/check`
Admin post delete: `/v1/admin/posts/:id`
Admin block/unblock: `/v1/admin/users/:uid/block`

After deployment, copy the HTTPS API origin into:
- Admin Panel → Settings → FFBDWorld API Connection → Save & Connect
- Website → Settings → FFBDWorld API → Save API

## Security patch notes (v1.1.0)
- Admin authorization accepts the two required UIDs and the two configured admin email identities.
- Star purchase requests validate the 120 Stars = BDT 100 rate and require a payment reference.
- Star withdrawal requests are processed by the trusted API and atomically deduct available Stars while creating the pending withdrawal record.
- Admin Star purchase approval credits the user's Stars in a Firestore transaction; duplicate review is rejected.
- Admin Star withdrawal rejection refunds Stars; marking paid clears the pending amount.
- Website Star purchase/withdrawal and Admin Star approval/withdrawal review are routed through the API instead of direct client writes.
