# Tennis Scorer: Apple Watch Shortcut

Use these instructions once **Apple Watch Scoring** appears under your profile's **Login & Security** settings. The shortcut has not yet been tested on a physical iPhone or Apple Watch. Apple notes that not all iPhone shortcuts work on Watch; test your exact iOS/watchOS versions and network before relying on it during a real match.

## Keep your key private

In the app, sign in and open your profile → **Login & Security** → **Apple Watch Scoring** → **Generate Watch Key**. Copy it while it is shown; it cannot be displayed again. The key is a bearer credential: anyone holding it can control your eligible live match. A Shortcuts **Text** action is convenient, but it is **not Apple Keychain**. Do not share or publish the shortcut with the key filled in; do not screenshot the key or paste it into an issue, chat or AI conversation. If exposed, revoke it in the same profile section and generate a new one.

## Build the initial request on iPhone

The names of Shortcuts controls may differ slightly by iOS version. Use **Select Variable** to insert the blue variable tokens; do not type their names as literal text.

1. Open **Shortcuts** → **+**. Name the shortcut **Tennis Scorer**; choose an icon if desired.
2. Add **Text** and paste your Watch key. Add **Set Variable**, name it `WatchToken`, and select the Text output.
3. Add **URL** with `https://banglasplayingtennis.netlify.app/.netlify/functions/api?action=watch-score`. Add **Set Variable** named `Endpoint` using that URL. The key must never be part of the URL.
4. Add **Get Contents of URL**, select `Endpoint`, open its options and choose **POST**. Under **Headers**, add `X-Watch-Token` with the `WatchToken` variable as its value. Set **Request Body** to **JSON** and add a Text field `operation` with value `state`.
5. Add **Get Dictionary from Input**, using the request result, then **Set Variable** named `MatchState` with that dictionary.
6. Add **Repeat**, set it to 100 times, and place the remaining actions inside the Repeat/End Repeat markers. The shortcut stops at the end of the loop; open it again to start with a fresh state.

## Read the state and choose a menu

At the top of each repeat, use **Get Dictionary Value** with `MatchState` as the dictionary to obtain `active`, `requiresPhoneAction`, `needsTiebreakChoice`, `completed`, `canUndo`, `canFinish`, `displayTitle`, `scoreLine`, `gamesLine`, `serverLine`, `message`, `matchId`, `version` and `nextActionId`. Use **Set Variable** for values needed later: `MatchId`, `Version` and `ActionId`. Use the dictionary booleans as booleans, not the text “true” or “false”.

1. Add **If** `active` is false: show an alert containing `message`, then **Stop This Shortcut**. Otherwise continue. A successful finish also returns `active=false` and `message=Match saved.`
2. Build a **Text** prompt from `displayTitle`, `scoreLine`, `gamesLine` and `serverLine`, each on a new line. Add `message` when present. Use this Text output as the prompt for each menu below.
3. Add nested **If** actions in this priority order. In each applicable branch add **Choose from Menu**, with exactly these choices. To avoid showing an unavailable Undo or Finish, make the indicated second menu inside an If on `canUndo` or `canFinish`:

   - If `requiresPhoneAction` is true: **Refresh**, **Exit**.
   - Otherwise, if `needsTiebreakChoice` is true: **Tiebreak to 5**, **Tiebreak to 7**, **Refresh**, **Exit**.
   - Otherwise, if `completed` is true: if both `canUndo` and `canFinish` are true, show **Undo**, **Save & End**, **Refresh**, **Exit**. If either is false, use a separate menu omitting that unavailable action.
   - Otherwise, if `canUndo` is true: **Team 1 +**, **Team 2 +**, **Undo**, **Refresh**, **Exit**. If false, use a separate menu omitting Undo.

4. Under each menu choice, put a **Text** action containing its operation below, followed by **Set Variable** named `Operation` using that Text output. For **Exit**, add **Stop This Shortcut** instead. For **Save & End**, first add **Show Alert** “Save and end this match?” with a Cancel button; continue to set `Operation` only after confirming. Depending on iOS version, Cancel may stop the shortcut; reopen it to refresh.

| Menu choice | Text assigned to `Operation` |
| --- | --- |
| Team 1 + | `team_a_plus` |
| Team 2 + | `team_b_plus` |
| Undo | `undo` |
| Tiebreak to 5 | `tiebreak_5` |
| Tiebreak to 7 | `tiebreak_7` |
| Save & End | `finish` |
| Refresh | `state` |

## Send the selected action

After the nested If/End If blocks, but still inside Repeat:

1. Add a second **Get Contents of URL** configured like the first: `Endpoint`, POST, header `X-Watch-Token` = `WatchToken`, JSON body.
2. Add these JSON fields, using variables—not typed literal variable names:
   - Text `operation`: `Operation`.
   - Text `matchId`: `MatchId`.
   - **Number** `expectedVersion`: `Version`.
   - Text `actionId`: `ActionId`.
3. A point consumes the `nextActionId` returned in the previous state. Do not generate a new one to retry an uncertain point. The server ignores the extra match/version/action fields for `state`, and ignores `actionId` for non-point operations.
4. Add **Get Dictionary from Input** for the response. Read `ok`, `conflict` and `message` with Get Dictionary Value. If `ok` is true, set `MatchState` to this response. If `conflict` is true, set `MatchState` to the returned authoritative response and show its message before looping. For another `ok=false` response, show its message and stop; reopen the shortcut so its initial `state` request refreshes before any more points.
5. Put **End Repeat** after that response handling. There is no extra refresh after a successful scoring action: the returned dictionary is the next state.

## Errors and first test

Ordinary scoring conflicts return HTTP 200 JSON with `ok=false`, `conflict=true` and the refreshed state. Invalid/expired/revoked keys return HTTP 401; inactive or unauthorized players return 403; malformed requests return 400; rate limits return 429; unavailable server returns 503. Depending on the Shortcuts version, **Get Contents of URL may stop the shortcut on a non-2xx response or connection failure before you can inspect JSON**. Do not blindly retry a point: reopen the shortcut, let the initial state request refresh, and review the score before tapping again. If the key is rejected, generate a new one in your profile and replace the Text value. The exact Watch-side behavior for HTTP/network failures must be tested on your devices.

First run the shortcut on iPhone with a disposable test match and confirm each menu, state update and Save & End confirmation. In the shortcut editor open **Details** → turn on **Show on Apple Watch** → Done. Open **Shortcuts** on the Watch and tap **Tennis Scorer**. If supported by your Watch face, add a Shortcuts complication or Smart Stack widget. Keep the Watch connected to a network capable of reaching the app. Test with the phone open, with it locked, and after a temporary connection loss before using it during play.

Apple references: [Request an API](https://support.apple.com/guide/shortcuts/apd58d46713f/ios), [Repeat actions](https://support.apple.com/guide/shortcuts/use-repeat-actions-apdc11deb2c1/ios), and [Run shortcuts on Apple Watch](https://support.apple.com/guide/shortcuts/apd5888b0858/ios).
