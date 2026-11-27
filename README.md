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

Open the URL printed in the terminal, normally `http://localhost:3000`, and sign in to the activity dashboard. Choose **Q&A** to create a question with predefined answers the audience can select; the host marks exactly one answer as correct before creating it. See [Q&A game](#qa-game) for the full flow. A Q&A question can be text only, or an uploaded image (JPEG, PNG, or WebP, 5 MB max) with an optional caption. Choose **QR Voting** to manage regular polls. Both use the poll dashboard and live QR voting flow. Choose **Vanishing Tic-Tac-Toe** to open game room management at `/game`, or **Selfie Cam** to create a guest photo-upload QR and moderate full-screen submissions at `/selfie`. Choose **QR Word Scramble** to run an audience word game with QR registration and secure winner selection at `/scramble`; see [QR Word Scramble](#qr-word-scramble). The voting management dashboard is also available at `/voting`. The development server serves both the app and API; MariaDB tables are created on first start from `db/mariadb-schema.sql`.

### Local testing with SQLite

To run a local test instance without MariaDB, use Node.js 22.13 or newer and select the SQLite driver in PowerShell:

```powershell
$env:DB_DRIVER = 'sqlite'
$env:SQLITE_PATH = 'data\roomvote-local.sqlite'
npm.cmd run dev
```

If `SQLITE_PATH` is omitted, the database defaults to `data/roomvote-local.sqlite`. It is separate from the MariaDB database and from the older SQLite migration source. The app also falls back to local SQLite when MariaDB credentials are not configured.

## Admin access

On first visit, create the initial admin account. Usernames must be 3–40 letters, numbers, dots, dashes, or underscores; passwords must be at least 12 characters. Sign in to access the dashboard. Admins can open **Manage users** to add more admins or hosts. Hosts can create polls but cannot manage accounts. Sessions expire after seven days.

Each account manages its own QR voting, Q&A, raffle, word scramble, and Selfie Cam sessions, image bank, and appearance. The first admin is the superadmin and can view and manage all activity sessions; other admins retain system-admin privileges but cannot manage another account's sessions. Image banks and theme drafts remain account-specific even for the superadmin. Public activity and display links continue to work and use the activity owner's published theme.

When creating a raffle, word scramble, or Q&A, optionally set the guest name field label shown during registration. Leave it blank to keep the default; Q&A labels can also be changed in its edit dialog. The field still collects and validates a guest's name.

In Appearance, the raffle, word scramble, and Selfie Cam display settings offer optional box color and opacity controls. They affect the open display only; Selfie Cam applies them to both the photo wall and QR panel while keeping the QR code readable. Save and publish the theme to make changes visible to guests.

The signed-out login page uses the superadmin's published appearance. To change it, sign in as the superadmin, update the appearance, and publish the theme. Before the first account is created, the login and setup page use the original shared theme.

On the first server start after upgrading, existing polls and Q&A are assigned to the earliest-created admin because their creators were not previously recorded. Existing raffle, word scramble, and selfie ownership is preserved. The existing shared image bank is assigned to the account named `admin`, and existing accounts start with the previous published and draft theme. Back up the database and theme-asset directory before upgrading. If the shared image bank contains images but `admin` does not exist, startup stops with an explicit migration error; create or identify that account before upgrading. Restart the API to apply the database migration.

## QR Raffle

Open **QR Raffle** from the host/admin dashboard (`/raffle`), create a raffle, and share its registration QR. Ticket holders register their name and ticket number once.

When creating a raffle, optionally upload or choose each of the two display images from your account's image bank. They appear beside the event name on the drawing and winner displays. Uploaded display images are also added to the bank.

In **Live randomizer**, set **Winners per draw** to a whole number from 1 to the remaining eligible ticket count, press **DRAW**, then **STOP**. The count is saved when the draw starts and cannot change during that draw. The server randomly selects that many distinct tickets; previous winners are excluded from all later draws.

Select **Reset event** and confirm to permanently delete all registrations and winner history and stop any active draw. The raffle name, images, and existing QR and display links remain available for a fresh event; guests must register again. Restart the updated API to add the reset tracking column to existing databases.

**Open display** (`/raffle/:id/display`) shows the registration QR before the first draw, the randomizer during drawing, and the latest draw's complete winner list afterward, with one row per winner showing their number, name, and ticket number, like the host results. For one to four winners the rows expand to fill the available display area; for one or two winners, names use 100px text and ticket numbers use 60px text. Lists can be scrolled if their content exceeds the available space. The list survives a display refresh. The host sees the latest winners in the randomizer and all past winners in **Winners**. Restart the updated API to apply the database columns automatically; existing raffles default to one winner per draw.

Validate the raffle API with `node --test server/raffle.test.mjs`.

If the raffle page reports that the server is out of date after an update, stop the running local dev command with `Ctrl+C`, run `npm run dev` again, and refresh the browser. Vite reloads frontend changes automatically, but the Node API must be restarted to load backend changes and apply database updates.

## Vanishing Tic-Tac-Toe

Admins can manage up to three active Vanishing Tic-Tac-Toe rooms at `/game`. Use **Game Appearance & Theme** there to separately customize the game title, images, colors, background, layout, and effects; save a private draft, preview desktop/mobile, and publish changes only to game pages. This game theme does not change the main site or voting theme. Give each room a name and optionally upload custom X and O images (JPEG, PNG, or WebP, up to 5 MB each); the images are validated by the server, stored in MariaDB, and shown on both player boards and the admin spectator board. Each room has its own QR code for both players to scan; the first player is X and the second is O. Admins can reopen a room QR code and open a read-only spectator view; spectator access requires the admin account and does not occupy a player slot. Admins can close rooms to free a slot; closing a room disconnects both players. Both boards synchronize through the server. Each player keeps up to three active marks during play; on a non-winning fourth move in an empty square, their oldest mark disappears. If the move makes three-in-a-row, the winning marks stay on the board and the game ends. After a match, both players can vote on a rematch during a shared 20-second countdown; the same room restarts only if both agree. A decline or timeout leaves the finished game in place. Rooms with no activity expire after 24 hours and no longer count against the three-room limit. For phones to join a locally hosted game, all devices need to be on the same Wi-Fi network.

## Selfie Cam

Admins can open **Selfie monitor** from the dashboard (`/admin/selfie`) to view their current and saved sessions, upload/pause status, and pending or approved photos. The superadmin can view all accounts' sessions. It refreshes every three seconds and is read-only. Choose **Manage Selfie Cam sessions** to approve/delete photos, pause playback, end uploads, or copy OBS links. The monitoring API and photo URLs require an admin login.

Open **Selfie Cam** from the signed-in host/admin activity dashboard and create a session QR for guests to scan. Optionally upload a JPEG, PNG, or WebP logo (5 MB max) for the center of the QR code. Guests can take a selfie or upload a JPEG, PNG, or WebP image (5 MB max); the camera requires HTTPS or localhost and browser permission. Photos are sent to the server and remain private in a review queue until the host or an admin approves them. They can reject and delete a photo, or show an approved image full-screen. Full-screen display uses `object-fit: contain`, so portrait photos are not cropped or stretched; the rotating live and OBS displays fill unused space with a blurred, translucent copy of the current photo. **There is no session duration or automatic expiry.** Uploads remain open until the host or an admin selects **End session**. Ending stops new uploads but preserves the session and its photos for later review and playback; it cannot be reopened for uploads.

The in-app camera preview and captured selfie are not mirrored. Uploaded photos are stored without image processing, retaining their embedded orientation metadata; compatible browsers apply that orientation when displaying them. Guest previews, review thumbnails, admin monitoring, full-screen previews, and live/OBS output fit the complete image without cropping or stretching. Photos previously captured with the old mirrored camera behavior remain unchanged.

The **Recent sessions** list on `/selfie` shows newest sessions first, including ended sessions, with host, creation time, status, total photos, and approved-photo counts. Select any session you can manage to review its saved uploads, approve/delete photos, pause/resume its display, or reuse it in OBS. **New session** opens the creation form without closing other sessions. Sessions and photos survive server restarts. Data already removed by the old expiry/deletion behavior cannot be recovered; back up the database before upgrading. Existing retained sessions also stop using their old expiry timestamps.

In **Photo review**, select individual approved photos or **Select all approved**, then choose **Delete selected** and confirm to permanently delete them. Pending photos are not included. Set **Photo rotation** to a whole number from 2 to 300 seconds and save it to change how long photos stay on that session's live screen and OBS display. The default is 5 seconds; the setting is saved with the session, including ended sessions, and updates existing displays without changing their links. Restart the updated API to add the setting to existing databases.

Photo review loads images as they approach the visible area and waits for each automatic list refresh to finish before starting the next one. If the server or proxy returns an incomplete response, the page reports its HTTP status; check the corresponding production server and proxy logs if the error persists.

There is no photo-count limit per selfie session. Each photo must still pass image validation and remain within the 5 MB size limit. Host approval, pause, and end-session controls still apply. Available database storage limits total capacity.

Hosts/admins can choose **Preview full screen** on a pending photo to inspect it before approval. This private preview does not approve the photo or show it on the live/OBS display. Exit full screen to return to the review queue and approve or reject it.

Select an ended session and choose **Delete session** to permanently remove it, all its uploaded photos, and its guest/display links after confirmation. Its OBS URLs will stop working. Accounts can delete only their own ended sessions; the superadmin can delete any ended session. Ongoing sessions must be ended first.

Hosts can choose **Create selfie QR code** for regular selfies. The Santa QR creation button is currently hidden; existing Santa-enabled sessions still work. In Santa sessions, the live camera preview includes **Take a selfie with 3D Santa**, enabled by default and optional for guests. Regular sessions do not show the Santa effect. A gently moving, stylized 3D Santa appears on the camera image and is included in the captured photo sent to the host. This is a screen overlay, not room-tracked AR. It requires WebGL and live camera access over HTTPS (or localhost); photos chosen from the device and the phone's fallback camera do not receive the overlay. The Santa model is [Storybook Santa by 3D Assets](https://3dassets.dev/assets/christmas-storybook-storybook-santa-673e2b29), licensed under CC0 1.0. Restart the updated API to apply the session-mode database column; existing sessions remain regular selfie sessions.

The live screen rotates approved photos at the session's configured duration (five seconds by default). Newly approved photos take priority over the regular rotation; if several arrive together, each is displayed before the regular carousel resumes. Pausing the session also pauses rotation and priority photos appear after it resumes.

For OBS, create or select a recent selfie session, select **Copy OBS URL**, and paste the entire URL (including everything after `#`) into **OBS → Sources → Add → Browser**. Set the Browser Source width to `1920` and height to `1080`. **Open live screen** opens a browser tab only; it does not automatically add or update an OBS source. The OBS link does not require browser login: its separate, hashed display token permits read-only access to that session's approved photos, never pending submissions or moderation APIs. Keep the link private: it remains valid after uploads end and across restarts. Selecting a saved session issues additional hashed guest/display links without invalidating previously shared QR codes or OBS URLs. **An open-session display shows that session's upload QR**, including when the display link contains only its display token. **Ended-session displays automatically show the newest ongoing session from the same host as their upload QR**, while continuing to rotate only the ended session's approved photos. New uploads go to the ongoing session's review queue, not the ended session. The QR updates every two seconds as sessions start or end; a paused ongoing session still shows its QR with an uploads-paused notice. If that host has no ongoing sessions, the QR is hidden and saved photos use the full display area. Another host's QR is never substituted. QR logos saved only in the host browser are not available in OBS, so OBS uses the plain guest QR. Restart the updated API to apply the live guest-token hash column and backfill retained sessions; previously shared OBS URLs need no changes.

Audience voting and results remain public so QR scans work without an account. The admin dashboard and poll-management APIs require a signed-in user.

After scanning a poll QR code, the server creates an anonymous, poll-specific voting session in an `HttpOnly`, `SameSite=Lax` cookie. Only a SHA-256 hash of the random session token is stored. Q&A participants register with a full name and ticket number first (see [Q&A game](#qa-game)); regular polls remain anonymous. Each session expires after seven days by default, and can submit one vote. Vote eligibility, option membership, session consumption, and vote recording are checked in a database transaction; a unique database constraint prevents a session from being counted twice. Set `VOTING_SESSION_DURATION_SECONDS` to configure expiry (60 seconds to 90 days). On HTTPS, voting cookies are marked `Secure`; if TLS terminates at a reverse proxy, set `TRUST_PROXY_HOPS` to the number of trusted proxy hops. Only enable this for trusted proxies that overwrite forwarded headers.

This enforces one vote per server-issued session, not one vote per person: someone can obtain another session using another browser/device or by clearing cookies. Existing vote totals and historical vote rows are preserved when upgrading. Any stored phone-number digests from the removed SMS verification feature are erased during server startup; historical votes remain.

Use the monitor icon beside a regular poll to open its live scoreboard with vote totals and percentages, or beside a Q&A to display the first correct respondent (open this page while signed in; it is hidden from anonymous visitors so the answer cannot leak). Both refresh every two seconds and include a participant QR code. Use the full-screen control when presenting on a venue display.

When creating a poll, optionally upload a JPEG, PNG, or WebP logo (up to 5 MB). It is stored with that question and embedded in its QR codes. You can also add a separate JPEG, PNG, or WebP image (up to 5 MB each) to each answer option; those images appear with the choices on voting pages and live results.

## QR Word Scramble

Choose **QR Word Scramble** on the activity dashboard (`/scramble`) to run an audience word game. The host creates a game with a title and a correct word or phrase; the server automatically generates a scrambled version (preserving every letter and spaces between words) that the host can reshuffle or edit manually before the game starts. The correct answer stays private on the server and is never included in public API responses until the host announces a winner.

Before creating a game, optionally upload a QR logo or select one from your image bank. You can also upload or choose each of two optional display images from the bank; they appear to the left and right of the event name at the top of the winner and completion displays. Uploaded display images are also added to the bank. The registration screen shows only the QR code and scan prompt. Images accept JPEG, PNG, and WebP files up to 5 MB each. Existing games retain previously uploaded display logos. Restart the updated API to add the display-image columns to existing databases.

**Audience flow** (phone, via the one QR code that stays valid for the whole event): scan → register once with a name and ticket number (ticket numbers are unique per game, compared case-insensitively and ignoring spaces) → when the host starts the game, unscramble the word and submit exactly one answer → the QR Word Scramble ad video plays full-screen (see [Video ads](#video-ads)) → a **THANK YOU FOR PARTICIPATING!** screen shows **CORRECT** (entered into the eligible winner pool) or **INCORRECT** (not eligible). Answers are validated on the server: case-insensitive, trimmed, and whitespace-normalized. Duplicate registrations and repeat submissions are rejected by the backend, not just the UI.

**Host controls** (`/scramble`): start, pause, resume, and close the game; reset the event; live statistics (registrations, answers, correct/incorrect, eligible pool, winners, announced); and a searchable participant table. After closing the game, the host chooses how many winners to draw (never more than the eligible pool). **Randomize winners** selects them on the server with `crypto.randomInt` so every correct answer has an equal chance — submission order never matters, and a participant cannot win twice. The selection is shown privately for review and can be re-randomized before **Confirm winners**; confirmed winners can be announced individually or all at once. Announcing the first winner also reveals the correct answer. All host actions are written to `audit_logs`.

**Big-screen display** (`/scramble/:id/display`, works as an OBS Browser Source at 1920×1080; double-click or press `F` for full screen): shows the registration QR and scan prompt before the start, the scrambled word while the game runs, and the correct answer together with announced winners. Winners appear in the same numbered list as QR Raffle, including on the completion screen. The display never shows the randomizer, the eligible pool, or the correct answer before an announcement — only host-confirmed, announced winners appear. Set `SCRAMBLE_REGISTRATION_LIMIT_PER_MINUTE` and `SCRAMBLE_ANSWER_LIMIT_PER_MINUTE` (default 60 each) to tune the per-IP rate limits.

Word scramble pages follow the published [Appearance & Theme Settings](#appearance--theme-settings): the host dashboard uses the admin background, the audience page the voting background, and the big-screen display the results background. The raffle-style winner list uses the same fixed colors as QR Raffle.

## Q&A game

A Q&A is a quiz: one question, up to 8 answers, exactly one correct. Any participant who picks the correct answer is a **winner**; winners are ranked by submission time.

**Audience flow** (phone, via the QR code): enter full name and ticket number → read the question → pick one large answer button → press **ENTER** (the answer is locked) → a full-screen video ad plays → the **WINNER!** (with confetti) or **BETTER LUCK NEXT TIME!** screen appears. Each ticket number can register once per Q&A (case-insensitive). If the browser blocks autoplay, a **Tap to play** button appears. The correct answer is shown to losing participants only if the host enables **Reveal correct answer**.

**Ad validation:** the server records the ad start, progress heartbeats and completion in `ad_playbacks` (session, ad ID, start/completion time, status). Completion is accepted only when enough real time has passed and the reported playback position is consistent with it; the duration comes from the uploaded MP4 itself. `GET /api/polls/:id/result` returns `403 AD_REQUIRED` until then, so the result cannot be opened directly. If no Q&A video is uploaded under **Videos**, the result shows right after ENTER. WebM files have no server-readable duration, so the check falls back to the browser-reported length; use MP4 for strict validation.

**Host dashboard** (`/voting?mode=qa`): create Q&As (drag and drop works for the question image and QR logo), show the QR code, **Download PNG** (1024 px) or **Full screen** it for the event screen, switch answers on/off, edit the question and answers, delete a Q&A, and see participants, answers, winners and non-winners per Q&A. The correct answer cannot change once anyone has answered.

**Live winner monitor** (`/poll/:id/monitor`, sign-in required): summary cards (participants, submissions, winners, non-winners, participation %, ads completed), a table with rank, name, ticket, question, answer, WIN/LOSE, time, ad status and verification, newest first. It updates live over server-sent events, flashes a notification for each new winner, supports search by name or ticket, winner/non-winner filters, and **Export CSV** (opens in Excel). Admins can mark a winner **Verified** or **Rejected** after checking the physical ticket.

**Security:** the correct answer, winners and statistics are only returned to the owning account and the superadmin; the winner is decided on the server. Admin and host actions (create, edit, delete, settings, exports, verification, video uploads) are written to `audit_logs` (admins can read their own at `GET /api/admin/audit-logs`, while the superadmin can read all); login and audience endpoints are rate-limited per IP. Because a venue's Wi-Fi often shares one IP, the audience limit is generous; set `QA_RATE_LIMIT_PER_MINUTE` (default 3000) to tune it.

**Stack:** React + Vite, Express and MariaDB (`mysql2`), with server-sent events instead of Socket.IO and images stored in MariaDB (videos and theme images are files under `DATA_DIR`).

### Installation and deployment

1. Install Node.js (24 recommended), create a MariaDB 10.5+ database and user, and run `npm install`.
2. Development: `npm run dev` serves Vite and the API together. Production: `npm run build` then `npm start`. Both use `PORT` (default `3000`).
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

Admins can open **Videos** from the dashboard (`/admin/videos`) and upload one MP4 or WebM each for polls, Q&A, Vanishing Tic-Tac-Toe, Selfie Cam, QR Raffle, and QR Word Scramble. The poll video plays full-screen on a participant's phone right after their vote is recorded; the Q&A video plays the same way after a participant presses **Enter** on a Q&A answer (Q&A uses its own slot, not the poll video); the game video plays for both players when a match ends; the selfie video plays on a guest's phone right after they send their photo; the raffle video plays on a ticket holder's phone after successful raffle registration; the word scramble video plays right after a participant submits their answer, before the thank-you and correct/incorrect result appears (with no scramble video uploaded, the poll video is used; with neither, the result shows immediately). Viewers cannot skip, seek, pause, or close the video during playback; it closes when it finishes. Playback failures show a retry screen; non-Q&A activities also offer **Continue**. With no video uploaded, nothing plays. Files are stored under `data/ad-videos` (back it up together with the MariaDB database). Set `AD_VIDEO_MAX_BYTES` to change the 200 MB upload limit (1 byte–1 GB). The game rematch countdown is a fixed 20 seconds and keeps running while the video plays.

For iPhone/iPad compatibility, use an MP4 encoded with H.264 video (8-bit, 4:2:0) and AAC audio; an `.mp4` extension alone does not guarantee compatible codecs. Ads attempt inline playback with audio enabled. If the browser blocks autoplay with sound (as iOS commonly does), **Tap to play** starts the video with audio; there is no muted-playback fallback or separate sound button. Playback errors offer a retry rather than silently dismissing the video. Q&A results remain locked until the server confirms ad completion. The host/reverse proxy must preserve video byte-range requests and return `206 Partial Content` with a valid `Content-Range` for them.

## Appearance & Theme Settings

Every account can open **Appearance & Theme Settings** from the dashboard. Set the event title, logo, banner, global background, and separate voting, results, and admin backgrounds; adjust colors, image positioning and display mode, overlay, card corners, and glow; and preview desktop and mobile layouts. Use **Save draft** to persist private changes and **Publish theme** to apply them to the account's activity and audience pages. Restoring defaults requires confirmation and does not change polls or votes.

Theme images are limited to JPEG, PNG, or WebP, 50 MB per file by default, 12,000 pixels per side, and 40 megapixels. Set `THEME_IMAGE_MAX_BYTES` to configure the upload limit (1 byte–200 MB). SVG is rejected. The server verifies image signatures and dimensions, rate-limits uploads, and stores files under `data/theme-assets` outside the public static directory. Draft image URLs and theme-management APIs require the owning account; public image URLs resolve only assets referenced by a published theme. Images are preserved as uploaded (not resized). Back up the MariaDB database and `data/theme-assets` together; losing the asset folder can leave theme references without their image files.

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