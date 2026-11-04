# VOTE

VOTE is a self-hosted live polling app. Create a question, display its QR code, and let people vote from their phones. Polls, individual votes, and captured selfies are stored in a local SQLite database.

## Requirements

- Node.js 22.13+ (uses the built-in `node:sqlite` module)
- npm

## Run locally

```powershell
npm install
npm run dev
```

Open the Vite URL printed in the terminal, normally `http://localhost:5173`. The API runs on port `4180`; the SQLite database is created at `data/roomvote.sqlite`.

## Admin access

On first visit, create the initial admin account. Usernames must be 3–40 letters, numbers, dots, dashes, or underscores; passwords must be at least 12 characters. Sign in to access the dashboard. Admins can open **Manage users** to add more admins or hosts. Hosts can create polls but cannot manage accounts. Sessions expire after seven days.

Audience voting, selfie upload, results, and selfie-cam pages remain public so QR scans work without an account. The admin dashboard and poll-management APIs require a signed-in user.

Use the monitor icon beside any poll to open its live scoreboard. It shows vote totals and percentages, refreshes every two seconds, and includes a QR code for participants. Use the full-screen control when presenting it on a venue display.

When creating a poll, optionally upload a JPEG, PNG, or WebP logo (up to 5 MB). It is stored with that question and embedded in its QR codes across the share, results, and selfie-cam screens.

On the voting page, participants can optionally use **Add a selfie** to open their phone's front-camera capture. The image uploads to the local server, is stored in the SQLite database, and appears on `/poll/<poll-id>/selfie-cam`. Each browser can replace or remove its own poll selfie. Uploads accept JPEG, PNG, or WebP images up to 5 MB.

The first server start imports existing polls and vote counts from `data/polls.json`; that legacy file is kept unchanged as a backup. Historical voter IDs are preserved, though the legacy format did not record which option each voter selected.

To let phones on the same Wi-Fi join a poll, open the app using this computer's LAN address and the Vite port (for example, `http://192.168.1.20:5173`). If you create a poll from `localhost`, its QR code automatically uses the computer's detected private LAN address. Allow camera access when scanning from a browser; camera access requires HTTPS or localhost.

## Production build

```powershell
npm run build
npm start
```

The production server serves the built frontend and API on port `4180`. Set `PORT` to change the API port. Poll records and selfie image bytes persist in the SQLite database.

## Notes

This is a local/demo poll service, not a hardened public voting platform. Audience voting uses browser-generated voter IDs, and submitted selfies are visible to anyone with that poll's selfie-cam link. Use HTTPS, strong account credentials, consent messaging, retention limits, and abuse prevention before exposing it to the public internet.