# VOTE

VOTE is a self-hosted live polling app. Create a question, display its QR code, and let people vote from their phones. Polls, individual votes, and answer option images are stored in a MariaDB database.

## Requirements

- Node.js 18+ for the MariaDB mode (24 recommended)
- Node.js 22.13+ for local SQLite testing
- npm
- MariaDB 10.5+ (a database and a user with full rights on it)

## Run locally

Create a database and set its connection string (or `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`); the tables are created automatically on first start:

```powershell
$env:DATABASE_URL = 'mysql://vote:password@127.0.0.1:3306/vote'
npm install
npm run dev
```

Open the Vite URL printed in the terminal, normally `http://localhost:5173`, and sign in to the activity dashboard. Choose **Q&A** to create a question with predefined answers the audience can select; the host marks exactly one answer as correct before creating it. See [Q&A game](#qa-game) for the full flow. A Q&A question can be text only, or an uploaded image (JPEG, PNG, or WebP, 5 MB max) with an optional caption. Choose **QR Voting** to manage regular polls. Both use the poll dashboard and live QR voting flow. Choose **Vanishing Tic-Tac-Toe** to open game room management at `/game`, or **Selfie Cam** to create a guest photo-upload QR and moderate full-screen submissions at `/selfie`. The voting management dashboard is also available at `/voting`. The API runs on port `4179`; the MariaDB tables are created on first start from `db/mariadb-schema.sql`.

### Local testing with SQLite

To run a local test instance without MariaDB, use Node.js 22.13 or newer and select the opt-in SQLite driver in PowerShell:

```powershell
$env:DB_DRIVER = 'sqlite'
$env:SQLITE_PATH = 'data/roomvote-local.sqlite'
npm run dev
```

If `SQLITE_PATH` is omitted, the database defaults to `data/roomvote-local.sqlite`. It is separate from the MariaDB database and from the older SQLite migration source. `DB_DRIVER` is not set by default, so production continues to use MariaDB.

## Admin access

On first visit, create the initial admin account. Usernames must be 3–40 letters, numbers, dots, dashes, or underscores; passwords must be at least 12 characters. Sign in to access the dashboard. Admins can open **Manage users** to add more admins or hosts. Hosts can create polls but cannot manage accounts. Sessions expire after seven days.

## Vanishing Tic-Tac-Toe

Admins can manage up to three active Vanishing Tic-Tac-Toe rooms at `/game`. Use **Game Appearance & Theme** there to separately customize the game title, images, colors, background, layout, and effects; save a private draft, preview desktop/mobile, and publish changes only to game pages. This game theme does not change the main site or voting theme. Give each room a name and optionally upload custom X and O images (JPEG, PNG, or WebP, up to 5 MB each); the images are validated by the server, stored in MariaDB, and shown on both player boards and the admin spectator board. Each room has its own QR code for both players to scan; the first player is X and the second is O. Admins can reopen a room QR code and open a read-only spectator view; spectator access requires the admin account and does not occupy a player slot. Admins can close rooms to free a slot; closing a room disconnects both players. Both boards synchronize through the server. Each player keeps up to three active marks during play; on a non-winning fourth move in an empty square, their oldest mark disappears. If the move makes three-in-a-row, the winning marks stay on the board and the game ends. After a match, both players can vote on a rematch during a shared 20-second countdown; the same room restarts only if both agree. A decline or timeout leaves the finished game in place. Rooms with no activity expire after 24 hours and no longer count against the three-room limit. For phones to join a locally hosted game, all devices need to be on the same Wi-Fi network.

## Selfie Cam

Open **Selfie Cam** from the signed-in host/admin activity dashboard and create a session QR for guests to scan. Optionally upload a JPEG, PNG, or WebP logo (5 MB max) for the center of the QR code. Guests can take a selfie or upload a JPEG, PNG, or WebP image (5 MB max); the camera requires HTTPS or localhost and browser permission. Photos are sent to the server and remain private in a review queue until the host approves them. The host can reject and delete a photo, or show an approved image full-screen. Full-screen display uses `object-fit: contain`, so portrait photos are not cropped or stretched; unused screen area appears black. Sessions expire after four hours, and ending a session deletes its submissions.

The live screen rotates approved photos every five seconds. Newly approved photos take priority over the regular rotation; if several arrive together, each is displayed before the regular carousel resumes. Pausing the session also pauses rotation and priority photos appear after it resumes.

For OBS, create a selfie session, select **Copy OBS URL**, and paste the entire URL (including everything after `#`) into **OBS → Sources → Add → Browser**. Set the Browser Source width to `1920` and height to `1080`. **Open live screen** opens a browser tab only; it does not automatically add or update an OBS source. The OBS link does not require browser login: its separate, hashed display token permits read-only access to that session's approved photos, never pending submissions or moderation APIs. Keep the link private; it stops working when the session ends or expires. After updating the server, create a new session to obtain an OBS link; older signed-in display links still work in the host browser. QR logos saved only in the host browser are not available in OBS, so OBS uses the plain guest QR.

Audience voting and results remain public so QR scans work without an account. The admin dashboard and poll-management APIs require a signed-in user.

After scanning a poll QR code, the server creates an anonymous, poll-specific voting session in an `HttpOnly`, `SameSite=Lax` cookie. Only a SHA-256 hash of the random session token is stored. Q&A participants register with a full name and ticket number first (see [Q&A game](#qa-game)); regular polls remain anonymous. Each session expires after seven days by default, and can submit one vote. Vote eligibility, option membership, session consumption, and vote recording are checked in a database transaction; a unique database constraint prevents a session from being counted twice. Set `VOTING_SESSION_DURATION_SECONDS` to configure expiry (60 seconds to 90 days). On HTTPS, voting cookies are marked `Secure`; if TLS terminates at a reverse proxy, set `TRUST_PROXY_HOPS` to the number of trusted proxy hops. Only enable this for trusted proxies that overwrite forwarded headers.

This enforces one vote per server-issued session, not one vote per person: someone can obtain another session using another browser/device or by clearing cookies. Existing vote totals and historical vote rows are preserved when upgrading. Any stored phone-number digests from the removed SMS verification feature are erased during server startup; historical votes remain.

Use the monitor icon beside a regular poll to open its live scoreboard with vote totals and percentages, or beside a Q&A to display the first correct respondent (open this page while signed in; it is hidden from anonymous visitors so the answer cannot leak). Both refresh every two seconds and include a participant QR code. Use the full-screen control when presenting on a venue display.

When creating a poll, optionally upload a JPEG, PNG, or WebP logo (up to 5 MB). It is stored with that question and embedded in its QR codes. You can also add a separate JPEG, PNG, or WebP image (up to 5 MB each) to each answer option; those images appear with the choices on voting pages and live results.

## Q&A game

A Q&A is a quiz: one question, up to 8 answers, exactly one correct. Any participant who picks the correct answer is a **winner**; winners are ranked by submission time.

**Audience flow** (phone, via the QR code): enter full name and ticket number → read the question → pick one large answer button → press **ENTER** (the answer is locked) → a full-screen video ad plays → the **WINNER!** (with confetti) or **BETTER LUCK NEXT TIME!** screen appears. Each ticket number can register once per Q&A (case-insensitive). If the browser blocks autoplay, a **Tap to play** button appears. The correct answer is shown to losing participants only if the host enables **Reveal correct answer**.

**Ad validation:** the server records the ad start, progress heartbeats and completion in `ad_playbacks` (session, ad ID, start/completion time, status). Completion is accepted only when enough real time has passed and the reported playback position is consistent with it; the duration comes from the uploaded MP4 itself. `GET /api/polls/:id/result` returns `403 AD_REQUIRED` until then, so the result cannot be opened directly. If no Q&A video is uploaded under **Videos**, the result shows right after ENTER. WebM files have no server-readable duration, so the check falls back to the browser-reported length; use MP4 for strict validation.

**Host dashboard** (`/voting?mode=qa`): create Q&As (drag and drop works for the question image and QR logo), show the QR code, **Download PNG** (1024 px) or **Full screen** it for the event screen, switch answers on/off, edit the question and answers, delete a Q&A, and see participants, answers, winners and non-winners per Q&A. The correct answer cannot change once anyone has answered.

**Live winner monitor** (`/poll/:id/monitor`, sign-in required): summary cards (participants, submissions, winners, non-winners, participation %, ads completed), a table with rank, name, ticket, question, answer, WIN/LOSE, time, ad status and verification, newest first. It updates live over server-sent events, flashes a notification for each new winner, supports search by name or ticket, winner/non-winner filters, and **Export CSV** (opens in Excel). Admins can mark a winner **Verified** or **Rejected** after checking the physical ticket.

**Security:** the correct answer, winners and statistics are only returned to signed-in users; winner is decided on the server; admin and host actions (create, edit, delete, settings, exports, verification, video uploads) are written to `audit_logs` (admins can read them at `GET /api/admin/audit-logs`); login and audience endpoints are rate-limited per IP. Because a venue's Wi-Fi often shares one IP, the audience limit is generous; set `QA_RATE_LIMIT_PER_MINUTE` (default 3000) to tune it.

**Stack:** React + Vite, Express and MariaDB (`mysql2`), with server-sent events instead of Socket.IO and images stored in MariaDB (videos and theme images are files under `DATA_DIR`).

### Installation and deployment

1. Install Node.js (24 recommended), create a MariaDB 10.5+ database and user, and run `npm install`.
2. Development: `npm run dev` (Vite on `5173`, API on `4179`). Production: `npm run build` then `npm start`, which serves the app and API on `PORT` (default `4179`).
3. Open the site and create the first admin account on the setup screen. Admins can add hosts under **Manage users**.
4. Upload the Q&A advertisement (MP4 recommended) under **Videos**.
5. Put the app behind HTTPS (camera scanning and secure cookies need it). If a reverse proxy terminates TLS, set `TRUST_PROXY_HOPS`. Disable response buffering for `/api/polls/*/monitor/stream` (nginx: `proxy_buffering off`).
6. Persist and back up `DATA_DIR` (default `./data`, holds `ad-videos` and `theme-assets`) together with the MariaDB database. Run a single server instance, since the in-memory rate limiter and event bus are per process. The MariaDB `max_allowed_packet` must be at least 8 MB (images are up to 5 MB).

Environment variables: `DATABASE_URL` (or `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`), `DB_CONNECTION_LIMIT`, `PORT`, `DATA_DIR`, `TRUST_PROXY_HOPS`, `QA_RATE_LIMIT_PER_MINUTE`, `VOTING_SESSION_DURATION_SECONDS`, `AD_VIDEO_MAX_BYTES`, `THEME_IMAGE_MAX_BYTES`.

### Admin quick guide

1. **Before the event:** upload the ad under **Videos**; choose **Q&A** on the dashboard; type the question (or upload an image), add 2–8 answers, tick the correct one, optionally add a QR logo and tick *Reveal correct answer*; press **Create Q&A**.
2. **Show the QR:** use the QR icon on the Q&A row → **Full screen** on the event display, or **Download PNG** for print.
3. **During the event:** open the monitor (people icon) on the production screen. Use the *Answers enabled* switch to open or close entries.
4. **After:** filter **Winners**, check each ticket, press **Verify**, then **Export CSV**.

## Video ads

Admins can open **Videos** from the dashboard (`/admin/videos`) and upload one MP4 or WebM each for polls, Q&A, Vanishing Tic-Tac-Toe, Selfie Cam, and QR Raffle. The poll video plays full-screen on a participant's phone right after their vote is recorded; the Q&A video plays the same way after a participant presses **Enter** on a Q&A answer (Q&A uses its own slot, not the poll video); the game video plays for both players when a match ends; the selfie video plays on a guest's phone right after they send their photo; the raffle video plays on a ticket holder's phone after successful raffle registration. Viewers cannot skip, seek, pause, or close the video during playback; it closes when it finishes. Playback failures show a retry screen; non-Q&A activities also offer **Continue**. With no video uploaded, nothing plays. Files are stored under `data/ad-videos` (back it up together with the MariaDB database). Set `AD_VIDEO_MAX_BYTES` to change the 200 MB upload limit (1 byte–1 GB). The game rematch countdown is a fixed 20 seconds and keeps running while the video plays.

For iPhone/iPad compatibility, use an MP4 encoded with H.264 video (8-bit, 4:2:0) and AAC audio; an `.mp4` extension alone does not guarantee compatible codecs. Ads attempt inline playback with audio enabled. If the browser blocks autoplay with sound (as iOS commonly does), **Tap to play** starts the video with audio; there is no muted-playback fallback or separate sound button. Playback errors offer a retry rather than silently dismissing the video. Q&A results remain locked until the server confirms ad completion. The host/reverse proxy must preserve video byte-range requests and return `206 Partial Content` with a valid `Content-Range` for them.

## Appearance & Theme Settings

Admins can open **Appearance & Theme Settings** from the dashboard. Set the event title, logo, banner, global background, and separate voting, results, and admin backgrounds; adjust colors, image positioning and display mode, overlay, card corners, and glow; and preview desktop and mobile layouts. Use **Save draft** to persist private changes and **Publish theme** to apply them to new and open audience pages. Restoring defaults requires confirmation and does not change polls or votes.

Theme images are limited to JPEG, PNG, or WebP, 50 MB per file by default, 12,000 pixels per side, and 40 megapixels. Set `THEME_IMAGE_MAX_BYTES` to configure the upload limit (1 byte–200 MB). SVG is rejected. The server verifies image signatures and dimensions, rate-limits uploads, and stores files under `data/theme-assets` outside the public static directory. Draft image URLs and theme-management APIs require an administrator session; public image URLs resolve only assets referenced by the published theme. Images are preserved as uploaded (not resized). Back up the MariaDB database and `data/theme-assets` together; losing the asset folder can leave theme references without their image files.

The first server start imports existing polls and vote counts from `data/polls.json`; that legacy file is kept unchanged as a backup. The legacy format did not record which option each voter selected.

To let phones on the same Wi-Fi join a poll, open the app using this computer's LAN address and the Vite port (for example, `http://192.168.1.20:5173`). If you create a poll from `localhost`, its QR code automatically uses the computer's detected private LAN address. Allow camera access when scanning from a browser; camera access requires HTTPS or localhost.

## Production build

```powershell
npm run build
npm start
```

The production server serves the built frontend and API on port `4179`. Set `PORT` to change the API port. Poll records and answer option images persist in the MariaDB database.

## Importing existing SQLite data

If you used an earlier SQLite version, `npm run migrate:mariadb` imports `data/roomvote.sqlite` into an empty MariaDB database (it creates the tables, keeps IDs and vote data, and copies theme image files). Back up first, then set `DATABASE_URL` to the destination. If the SQLite database has theme assets, also set `THEME_ASSETS_DESTINATION` to the directory for those image files (normally `<DATA_DIR>/theme-assets`). Optionally set `SQLITE_PATH` if the source is elsewhere. The importer needs Node.js 22.13+ (it reads SQLite with `node:sqlite`).

```powershell
npm run migrate:mariadb
```

This is a one-time import, not live synchronization. Ad videos in `data/ad-videos` must be copied separately.

## Notes

This is a local/demo poll service, not a hardened public voting platform. Use HTTPS, strong account credentials, and deployment-level abuse prevention before exposing it to the public internet.