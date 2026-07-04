# Queens Retreat — Backend Setup

The site is served by a Cloudflare Worker ([src/worker.js](src/worker.js)) that also handles
registrations and stores them in a Google Sheet. Follow these one-time steps to connect it.

## 1. Create the Google Sheet

1. Go to https://sheets.google.com and create a new spreadsheet (name it anything, e.g. *تسجيلات رتريت عودة الملكة*).
2. Leave the first tab empty — the Worker writes the header row automatically on the first registration.
3. Copy the **Sheet ID** from the URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_LONG_ID`**`/edit`

## 2. Create a Google service account

1. Go to https://console.cloud.google.com and create a project (e.g. `queens-retreat`).
2. **APIs & Services → Library** → search **Google Sheets API** → **Enable**.
3. **APIs & Services → Credentials → Create Credentials → Service account.**
   Any name works (e.g. `sheet-writer`). Skip the optional role/user steps.
4. Open the created service account → **Keys** tab → **Add key → Create new key → JSON** → download the file.
5. From the JSON file you need two values:
   - `client_email` (looks like `sheet-writer@queens-retreat.iam.gserviceaccount.com`)
   - `private_key` (the long block starting with `-----BEGIN PRIVATE KEY-----`)

## 3. Share the Sheet with the service account

In the spreadsheet click **Share**, paste the `client_email` address, give it **Editor** access, uncheck "Notify".

## 4. Add the secrets in Cloudflare

Cloudflare dashboard → **Workers & Pages → queensretreat → Settings → Variables and Secrets** → add three **secrets**:

| Name | Value |
|---|---|
| `SHEET_ID` | the ID from step 1 |
| `GOOGLE_SA_EMAIL` | `client_email` from the JSON |
| `GOOGLE_SA_PRIVATE_KEY` | the full `private_key` value, including the BEGIN/END lines |

(`TOTAL_CAPACITY` = 100 is a plain var in [wrangler.jsonc](wrangler.jsonc) — edit there if it ever changes.)

## 5. Deploy

Push to `main` — the connected Cloudflare build deploys automatically. Then verify:

- `https://<your-domain>/api/counts` returns JSON with `"ok": true`.
- Submit a test registration on the live site and confirm the row appears in the Sheet
  (you can delete test rows from the Sheet; counts update within ~30 seconds).

## Notes

- **Sheet columns changed in the July 2026 client-edits round**: the form now records
  المحطات والمواعيد (station + chosen time slot), ترتيب رعاية الأطفال, and عدد الأطفال instead of
  the old المحطات المختارة / اصطحاب أطفال / فئات الأطفال columns. If the Sheet already contains
  rows from the old form, clear the tab (or start a fresh tab) before deploying so the new
  header row is written cleanly.
- **Deleting a row in the Sheet frees a seat** — the counts are always computed from the Sheet.
- The seat counters cache for 30 seconds, so the public numbers can lag briefly; capacity checks during
  registration always use fresh data.
- The API returns Arabic error messages that the form shows directly to visitors.
