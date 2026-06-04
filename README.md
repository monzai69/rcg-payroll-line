# RCG Payroll LINE Server

LINE Bot + LIFF server for RCG Staff Portal.

## Features
- Staff registration (link LINE ID to staff profile)
- Leave request via LIFF
- Salary check via LIFF  
- Document request via LIFF
- Admin notifications via LINE push message

## Setup

### 1. Environment Variables (set in Railway)
```
LINE_LOGIN_CHANNEL_ID=2010289935
LINE_LOGIN_CHANNEL_SECRET=87dc062a176de3174f80d16231b12892
LIFF_ID=2010289935-ac793q9P
LINE_CHANNEL_ID=2010290143
LINE_CHANNEL_SECRET=f95bfe935c9e95afd1080e14ea575c34
LINE_CHANNEL_ACCESS_TOKEN=<your token>
BASE_URL=https://your-railway-url.up.railway.app
```

### 2. Firebase Service Account
Set `FIREBASE_SERVICE_ACCOUNT` environment variable in Railway with the JSON content.
OR upload serviceAccount.json (do NOT commit to git).

### 3. LINE Webhook
Set webhook URL in LINE Messaging API channel:
`https://your-railway-url.up.railway.app/webhook`

### 4. LIFF Endpoint
Set LIFF endpoint URL in LINE Login channel:
`https://your-railway-url.up.railway.app`

### 5. Register Admin LINE ID
After deploying, add yourself as admin by calling:
POST /api/set-admin-line-id with your LINE User ID

## Staff Registration
Staff sends to LINE OA: `register S1001`
System links their LINE ID to their staff profile.
