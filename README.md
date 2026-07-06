# Banglas Playing Tennis — shared online version

This repository deploys the public website to Netlify and stores shared EOIs,
events, payments, scores, media, roster details and the admin passcode in Supabase.

Players do not need an account. They choose their name from the roster.

## 1. Create the database

1. Create a project at https://supabase.com.
2. Open **SQL Editor**.
3. Open `supabase/schema.sql` from this repository.
4. Copy the complete file into the SQL Editor and select **Run**.

This creates the tables and the initial 18-player roster. Row Level Security is
enabled and the browser has no direct table access.

If you created the database using an earlier version, run the migration files
you have not previously applied. `002_court_fee.sql` changes only
the default court fee. `003_update_upcoming_court_fees.sql` changes upcoming
events still using the old $52 value to $54, while preserving other admin-set fees.
`004_second_court_and_media.sql` adds optional second-court fields, the media
archive table, and a public `tennis-media` Storage bucket. This migration must
be run before deploying the matching app/API update.

## 2. Upload this project to GitHub

1. Create a new empty GitHub repository.
2. Select **Add file → Upload files**.
3. Upload the contents of this folder, preserving the folders:

```
public/index.html
public/assets/tennis-app-icon.png
netlify/functions/api.mjs
supabase/schema.sql
supabase/migrations/001_add_scores.sql
supabase/migrations/002_court_fee.sql
supabase/migrations/003_update_upcoming_court_fees.sql
supabase/migrations/004_second_court_and_media.sql
netlify.toml
package.json
.gitignore
.env.example
README.md
```

4. Commit the uploaded files.

## 3. Connect GitHub to Netlify

1. In Netlify, select **Add new project → Import an existing project**.
2. Choose GitHub and select the repository.
3. Netlify reads `netlify.toml` automatically. No build command is required.
4. Publish the project.

## 4. Add private server settings in Netlify

Open **Site configuration → Environment variables** and create these values.
Set their scope to **Functions** where Netlify offers a scope choice.

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Supabase **Project Settings → API → Project URL** |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase private service-role/secret key |
| `ADMIN_SESSION_SECRET` | A long random value of at least 32 characters |
| `INITIAL_ADMIN_PASSCODE` | The first 4–8 digit admin passcode |

Never put the service-role key in `public/index.html`, GitHub, or any browser
code. After adding variables, trigger a new Netlify production deployment.

## Rules implemented

- Public player access with no account or password.
- Four upcoming Wednesday events are generated automatically.
- Newly generated events default to a $54 court fee; existing fees are retained.
- EOI options are only **I'm in** and **Can't make it**.
- Every week starts with no responses.
- EOIs lock six hours before the configured start time.
- After the deadline, the Play page shows the final player list, match time and location.
- Admin can add a second court with its own name, start time, end time and cost.
- When two courts are active, payment uses `(court 1 + court 2) ÷ In players + ball fee`.
- The final Play summary shows both courts and the combined court fee.
- The live EOI list labels every player as **In**, **Out** or **No reply**.
- The Payments tab and weekly history are always visible.
- Payment confirmation stays locked until that week's configured session end.
- After the session, only players marked **In** can confirm payment.
- Each player pays `total active court fees ÷ In players + ball fee`.
- The Media tab accepts images and videos up to 200 MB from any selected player.
- Media is sorted by date, displayed as gallery tiles and available for download.
- Admin can permanently remove an incorrect media upload.
- Weekly scores are visible to everyone, but only players marked **In** can add them.
- Every match is doubles: exactly two players on Team 1 and two on Team 2.
- Players can add and save any number of new teams and matchups for a week.
- Match history is retained in the database and remains available from the week selector.
- The all-time scoreboard gives every winning-team player a win and every losing-team player a loss.
- Sets are first to 4 games; at 3–3, the tie-break is first to 5 points and must be won by 2.
- The admin passcode is hashed and stored in Supabase.
- Admin sessions expire after eight hours.
- Admin can override any player's EOI before or after the six-hour deadline.
- Admin can rename roster players, correct paid/unpaid status and delete incorrect scores.

## Important identity limitation

Because players do not sign in, anyone with the public link can choose any
roster name. That is the tradeoff for completely password-free player access.
If stronger identity protection is later required, add a player PIN or email
magic-link step.
