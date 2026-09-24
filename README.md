# Personal Finance Tracker — Web App (GitHub Pages)

A private, offline-first personal finance tracker that runs **SQLite in your browser**
(via `sql.js`). It's a fully **static** site — perfect for GitHub Pages. No server, no
backend, no accounts. Your data never leaves your device.

- **Version:** 1.0.0
- **Base currency:** PHP (₱) · USD supported (edit FX in Settings)
- **Storage:** your browser (IndexedDB). Back up / move devices with **Export .db** → **Import .db**.
- **Reuses your existing database:** click **Import .db** and choose your `finance.db`
  (from the desktop app or an export). Same schema, so it just works.

## 🔒 Privacy first — read this before publishing

GitHub Pages sites are **public**: anyone with the URL can download any file in the repo.
So **do not commit your real `finance.db`** into the repo. This project ships with harmless
**sample data** in `data/finance.db`. Load your real data privately with the **Import .db**
button — it's stored only in your browser, never in the repo.

## Publish to GitHub Pages (step by step)

1. Create a GitHub account if you don't have one: <https://github.com/join>.
2. Click **New repository** → name it e.g. `finance-tracker` → **Public** (or Private if you have GitHub Pro) → **Create**.
3. On the repo page click **Add file ▸ Upload files**, then drag in **all** files from this
   `web-app` folder — `index.html`, `styles.css`, `app.js`, and the `data/` folder — and **Commit**.
4. Go to **Settings ▸ Pages**. Under *Build and deployment* set **Source: Deploy from a branch**,
   **Branch: `main`**, folder **`/ (root)`**, then **Save**.
5. Wait ~1 minute, refresh the Pages settings page, and open the URL it shows:
   `https://<your-username>.github.io/finance-tracker/`.
6. First load shows sample data. Click **Import .db** and pick your `finance.db` to load your
   real numbers (they stay in your browser only).

To update the site later, upload changed files to the repo again — Pages redeploys automatically.

## Run it locally first (optional)

Because it fetches the bundled database, open it through a tiny web server (not by double-clicking):

```
cd web-app
python -m http.server 8000
```

Then visit <http://localhost:8000>.

## Features (full parity)

Dashboard (KPIs, financial health score, forecast, spending doughnut + income/expense bar chart,
top purchases, budget health) · Transactions (with auto PHP conversion) · Accounts (auto balances) ·
Budgets · Savings Goals · Debt (payoff estimate) · Bills (auto status) · Net Worth (history + trend
line, snapshot button) · Settings (currencies/FX, categories, tags, export/import, reset).

## How your data flows

- On first visit it loads the bundled `data/finance.db` (sample) and copies it into your browser (IndexedDB).
- Every add/edit/delete saves back to IndexedDB automatically.
- **Import .db** replaces the working data with a `.db` you choose. **Export .db** downloads it back out.
- **Settings ▸ Data ▸ Reset to sample data** clears your browser copy and reloads the bundled sample.

## Notes

- Uses `sql.js` and `Chart.js` from a public CDN (jsDelivr). It needs internet to load those two
  libraries; your financial data itself is never sent anywhere.
- Credit cards: enter what you **owe** as a **negative** starting balance.

## Changelog

- **1.0.0** — Initial release: static sql.js web app, IndexedDB persistence, import/export `.db`,
  modern responsive UI, full feature parity, Chart.js visuals.
