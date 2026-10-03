# VoteChain V2 - Frontend design specification

Status: contract for the Step 11 frontend redesign. Files: `frontend/src/styles/tokens.css` (tokens),
`frontend/src/styles/components.css` (class vocabulary). Class names below are **stable**; implementers code against
them and must not invent parallel styles. Tailwind v4 utilities remain available for one-off spacing/layout
(`mt-4`, `grid`, `w-1/2`) but all colour, type, radius and shadow decisions come from the tokens.

`index.css` is exactly:

```css
@import "tailwindcss";
@import "./styles/tokens.css";
@import "./styles/components.css";
```

## 1. Visual identity - "ballot paper / civic system"

A supervised polling place, not a product dashboard. The interface looks like printed civic paper: a warm off-white
page (`--c-paper`), pure-white "sheets" (`--c-surface`) for the things you act on (ballot, tables, inputs, dialogs),
**hairline rules instead of boxes**, square corners, no shadows, no gradients, no decorative charts. Hierarchy comes
from type (serif headings vs sans UI vs mono identifiers), weight, spacing and rules.

Distinctive, deliberate details (these are what stop it looking like a template):

* A masthead: header sits on a **2px ink rule**; the brand mark is an **X in a ballot box** drawn in CSS.
* The ballot is a literal sheet: `.ballot` has a 2px ink edge, a ruled head band, and candidate rows are bordered
  boxes with a native radio ("tick the box").
* Receipts are a **dashed-edge stub** (`.receipt`), like a tear-off slip.
* Phase labels differ in fill, border style and glyph, not only colour (section 5).
* Result bars are a single flat measure with a hairline track; the number is the data, the bar is a ruler.

Explicitly not used: card grids, KPI tiles, gradients, glass, rounded containers (max radius 4px, tables/rows 0),
shadows (none; dialog edge is a 2px rule, scrim is the only translucent colour), pills, emoji icons, neon, crypto/DeFi
motifs, hero imagery, decorative animation.

### Colour: one accent, chosen and justified

**Accent = deep ink-blue `#1B3A5C`.** It is the colour of ballot-pen ink and official forms: institutional,
calm, politically neutral (no party owns navy-ink the way they own red, blue-bright, green). A *civic green* was
rejected because green already means "OK / success" in status language, and we need OK, OPEN and the accent to stay
distinguishable. It is desaturated (about 53% saturation, 24% lightness), so it reads as ink, not "tech blue". The page
neutrals are warm (paper, not slate), which keeps the blue from drifting to a SaaS look.

| Role | Token | Hex | Use |
|---|---|---|---|
| Page | `--c-paper` | `#F6F3EC` | background |
| Sheet | `--c-surface` | `#FFFFFF` | inputs, tables, ballot, dialog, header |
| Sunken | `--c-sunken` | `#ECE8DD` | table head, admin rail, bar track, skeleton |
| Hover | `--c-hover` | `#F1EEE5` | row/link hover |
| Ink | `--c-ink` | `#1A1D21` | primary text, CLOSED fill, focus ring, strong rules |
| Ink 2 | `--c-ink-2` | `#3B4148` | secondary text |
| Muted | `--c-muted` | `#555B63` | hints, meta (AA on paper/surface/sunken) |
| Faint | `--c-faint` | `#8B9096` | not used for content (reserved) |
| Rule | `--c-rule` | `#D6D0C2` | decorative hairlines only |
| Control | `--c-control` | `#6B7078` | borders of inputs, buttons, choice rows (3:1+) |
| Accent | `--c-accent` / `-hover` / `-tint` | `#1B3A5C` / `#102A45` / `#E2E9F2` | primary actions, links, selected, OPEN |
| Danger | `--c-danger` / `-hover` / `-tint` | `#9B1C1C` / `#7A1414` / `#F8E4E1` | errors, destructive |
| OK | `--c-ok` / `-tint` | `#1D6137` / `#E3F0E6` | confirmed only (never used as the accent) |
| Attention | `--c-warn` / `-edge` / `-tint` | `#6A4100` / `#A66A00` / `#FBEFCF` | warnings, pending |
| Scrim | `--c-scrim` | ink at 55% | dialog backdrop only |

### Contrast (computed with WCAG 2.x relative luminance; script kept outside the repo)

Text pairs need 4.5:1, UI/border/glyph pairs need 3:1. All pass.

| Foreground on background | Ratio | Needs |
|---|---|---|
| ink on paper / surface / sunken | 15.26 / 16.91 / 13.82 | 4.5 |
| ink-2 on paper / sunken | 9.31 / 8.43 | 4.5 |
| muted on paper / surface / sunken | 6.19 / 6.86 / 5.60 | 4.5 |
| accent on paper / surface / accent-tint (links, secondary buttons) | 10.49 / 11.63 / 9.51 | 4.5 |
| on-accent (white) on accent / accent-hover (primary button, OPEN) | 11.63 / 14.59 | 4.5 |
| ink on accent-tint (selected choice row) | 13.83 | 4.5 |
| danger on surface / paper / danger-tint | 8.15 / 7.35 / 6.67 | 4.5 |
| white on danger / danger-hover | 8.15 / 10.84 | 4.5 |
| ok on ok-tint / surface | 6.34 / 7.45 | 4.5 |
| warn on warn-tint / surface | 7.75 / 8.86 | 4.5 |
| white on ink (CLOSED label) | 16.91 | 4.5 |
| control border on surface / paper / sunken | 4.98 / 4.50 / 4.07 | 3 |
| ink focus ring on paper | 15.26 | 3 |
| accent glyph/edge on accent-tint / paper | 9.51 / 10.49 | 3 |
| warn-edge on warn-tint / paper | 3.92 / 4.05 | 3 |
| danger edge on danger-tint | 6.67 | 3 |
| ok edge on ok-tint | 6.34 | 3 |

`--c-rule` (1.3:1 on paper) is decorative only and must never be the sole boundary of an interactive control; controls
use `--c-control`.

## 2. Typography (no downloads, no CDN)

Three deliberate system stacks. Fonts are not fetched, so there is no flash, no privacy leak and nothing for a polling
station network to block.

| Role | Token | Stack | Why |
|---|---|---|---|
| Headings, ballot titles, display | `--ff-heading` | `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif` | Humanist book/serif faces give a printed-ballot, civic-record voice and clear hierarchy against UI text. Present on macOS/iOS (Iowan), Windows (Palatino/Sitka/Cambria), Linux (Charter/Georgia fallbacks). |
| UI, body, forms | `--ff-ui` | `"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Roboto, Arial, sans-serif` | Native, legible, accessible UI sans at small sizes; zero loading. |
| Identifiers, hashes, codes | `--ff-data` | `ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace` | Tx hashes, voter ids, nullifiers; tabular by nature; ligatures off. |

The **admin** shell switches headings to the UI sans (`--ff-heading: var(--ff-ui)`): dense operational screens are
technical, not editorial. Public and kiosk keep the serif.

Scale (rem tokens; contexts re-declare them):

| Token | Public | Kiosk | Admin |
|---|---|---|---|
| `--fs-xs` | 12px | 14px | 12px |
| `--fs-sm` | 14px | 16px | 13px |
| `--fs-base` (body) | 16px | **20px** | 15px |
| `--fs-md` | 18px | 22px | 16px |
| `--fs-lg` (h3) | 20px | 26px | 18px |
| `--fs-xl` (h2) | 24px | 32px | 22px |
| `--fs-2xl` (h1) | 30px | 40px | 26px |
| `--fs-3xl` | 38px | 48px | 30px |
| `--fs-4xl` (display) | clamp 36-52px | 60px | clamp 36-52px |

Weights 400/500/600/700. Line height: tight 1.15 (display/h1), snug 1.3, body 1.55 (kiosk 1.5, admin 1.45), prose 1.65.
Reading measure: `--w-prose` = 66ch (under the 70ch limit). Headings use `text-wrap: balance`, paragraphs `text-wrap: pretty`.
Numerals in tables, counts, countdowns and results use `tabular-nums` (`.num`, `.tabular`). Identifiers use `.mono`
(`overflow-wrap: anywhere`, so a 66-character hash never overflows). Use a real ellipsis character (`...` is `…`),
curly quotes, and non-breaking spaces between numbers and units in copy.

## 3. Spacing, shape, motion, layers

* Spacing: 4px base, `--s-1..--s-9` = 4, 8, 12, 16, 24, 32, 48, 64, 96px. Vertical rhythm via `.stack` (`--gap`, which
  the kiosk raises to 24px and admin lowers to 12px).
* Shape: `--r-0` 0 (rows, tables, alerts, choice rows), `--r-1` 2px (buttons, inputs, status), `--r-2` 4px (dialog, ballot).
  Nothing is rounder. Rules: hairline 1px, control 1px (kiosk 2px), strong 2px, heavy 4px (alert/phase/current edges).
* Focus ring: **3px solid ink, 2px offset**, on every `:focus-visible`, defined once in `@layer base`. Never removed.
  Choice rows move the ring from the small radio to the whole row. Under `forced-colors` it becomes `Highlight`.
* Motion: `--dur` 160ms, ease `cubic-bezier(.2,0,0,1)`. Only background/border/colour transitions (never `transition:
  all`), button press is a 1px translate, the spinner is the only loop. `prefers-reduced-motion: reduce` collapses all
  durations to ~0 and stops the spinner (it remains a static partial ring plus words).
* Layers: `--z-sticky 10, --z-header 20, --z-dialog 50, --z-skip 100`. No shadows exist.
* Tap behaviour: `touch-action: manipulation` on all interactive elements; tap highlight transparent (state change is
  visible instead).
* Tailwind exposure (`@theme`): default colours, radii, shadows, fonts and text sizes are **reset**, so `bg-blue-500`,
  `shadow-lg`, `rounded-xl` produce nothing. Available: `bg-paper|surface|sunken|hover|accent|accent-tint|danger|danger-tint|ok|ok-tint|warn|warn-tint`,
  `text-ink|ink-2|muted|accent|danger|ok|warn`, `border-rule|control|ink`, `font-heading|sans|mono`, `text-xs..4xl`
  (context-aware), `rounded-none|sm|lg`. Spacing keeps Tailwind's default 4px scale. Only `rounded-none` and `rounded-sm` for controls.

## 4. The three layout contexts

All three share the same components. A shell class on the outermost element re-scales tokens (type, control height,
gutter, rhythm), so a `.btn` is 44px in public, 56px in kiosk, 40px in admin without per-screen code.

| | PUBLIC `.shell-public` | VOTER KIOSK `.shell-kiosk` | ADMIN `.shell-admin` |
|---|---|---|---|
| Audience / device | anyone, any device, 390px up | voter at a supervised station, **1024x768 first**, touch | election officials, desktop 1280px+ |
| Body type | 16px, serif headings | **20px**, serif headings | 15px, sans headings |
| Chrome | masthead + top nav + footer | **thin identity strip only** + pinned action bar | header with phase + left rail |
| Content width | `--w-page` 72rem; prose 66ch | `--w-kiosk` 60rem, one centred column | fluid up to 100rem, left aligned |
| Controls | 44px | 56px (buttons), 72px primary `.btn-lg` and ballot rows, 2px borders | 40px, 32px `.btn-sm` |
| Navigation | Election, Verify a receipt, Results, How it works / Trust, Accessibility | none (a stepper shows progress; no free navigation) | rail: Election, Voters, Constituencies, Candidates, Biometrics, System |
| Density | airy, readable | very airy, one decision per screen | dense: tables, toolbars, rules |

### PUBLIC
Masthead: `.shell-brand` left, `.shell-nav` links, optional `.shell-meta` with a `.status` phase label. The current
page link has `aria-current="page"` (heavy accent underline + bold). On phones the nav wraps under the brand; links
stay at 44px tall. The footer carries an **honest scope statement**: a confirmed receipt proves a ballot was recorded
by this contract for this election and constituency; it does not prove who voted, ballot secrecy, receipt-freeness or
coercion resistance (the candidate id is plaintext on the chain). Pages open with `.page-head` (eyebrow, h1, lede). No
oversized hero: the first heading is the page's purpose, e.g. "Verify a receipt".

### VOTER KIOSK
Full-screen. Header strip (`--header-h` 52px): brand, constituency/station text, phase `.status`, `.countdown`.
Below it: `.stepper`, then one task. **One primary action per screen**, in the pinned `.shell-footer` bar
(`.container.actions.actions-between`: secondary left, primary right). Rules:

1. Body text >= 20px, minimum 16px for the smallest label; contrast >= 4.5:1.
2. **Ballot rows >= 56px tall (design: 72px)**, whole row is the hit target (`<label>` wraps the native radio).
   Rows are separated by a 12px gap so a miss never selects a neighbour.
3. Selection is native radio in a `<fieldset>` with a `<legend>`; a selected row has a filled radio, 2px accent border,
   tint, bold name and the visible word "Selected" with a tick. No gestures: everything is tap/click and keyboard.
4. No hover-only information, no tooltips, no double-click, no drag, no scrolling inside scrolling. Page may scroll
   vertically; the action bar stays pinned.
5. The countdown is always visible. It ticks visually; screen readers get a *separate* `visually-hidden` live region
   announced at fixed thresholds (e.g. 60s, 30s, 10s), never every second. When near expiry add `.is-urgent` **and**
   an `.alert-warn` explaining what happens ("Your session ends in 30 seconds. Touch Continue to stay.").
6. Confirm-before-cast uses a `.dialog` that restates the selected candidate name and has equal-sized Go back / Cast vote
   buttons. Cancel comes first in DOM and visually left.
7. Success/receipt screen: `.receipt` with `.dl`, a single `.btn-lg` "Finish", and a plain-language note that the
   recorded choice is shown on this screen only, not on the portable receipt.
8. Max 1024x768 verified; also works at 1280x800 and in portrait tablets. Never rely on viewport height.

### ADMIN
Dense, desktop-oriented, **not card-filled**. Structure: sticky header (brand, **persistent election-phase indicator
`.status.status-lg.phase-*` labelled "Election phase"**, user, sign out) -> left rail (`.shell-rail`) -> work area.
Hierarchy inside the work area, top to bottom:

1. `.page-head` (eyebrow = section name, h1, one-line state description).
2. At most one `.summary` strip of facts that matter (3-4), then any `.alert` that blocks the next step.
3. `.section`s separated by hairlines, each `.h2` + `.toolbar` + `.table-wrap > .table` + `.pager`.
4. Destructive actions (`btn-danger`) are small, last, and behind a `.dialog` confirmation naming what will happen.

Sections are divided by rules and whitespace, never wrapped in boxes. `.panel` is for the rare form that needs to be
visually separated; do not nest panels. Below 60rem the rail becomes a horizontal strip under the header.

## 5. Election-phase presentation

The phase is shown with the **word, a glyph and a fill/border treatment**, so it survives greyscale, colour blindness
and forced-colours mode.

| Phase | Class (on `.status` or `.phase-banner`) | Look | Glyph | Word |
|---|---|---|---|---|
| SETUP | `.phase-setup` | white, **dashed 2px ink border** | dashed ring | "Setup" |
| OPEN | `.phase-open` | **solid accent fill**, white text | filled disc | "Open" |
| CLOSED | `.phase-closed` | **solid ink fill**, white text | filled square | "Closed" |

* Always render the word. Never replace it with only an icon or colour.
* Placement: admin header (persistent, large), kiosk strip (small), public masthead meta, and as a `.phase-banner` at the
  top of public election/results/verify pages with a full sentence ("Voting is open until 18:00 on 3 November.",
  "Voting has closed. Results are final.", "The election is in setup. Voting has not started.").
* Phase banners use `.phase-banner.phase-*` with `role="status"` if they can change while the page is open.
* Generic statuses (`status-ok/warn/danger/info/neutral`) use different glyphs again: tick, triangle, diamond, ring, dash.
  The phase classes intentionally do not reuse the OK/warn/danger tones so "Open" is never read as "OK/success".

## 6. Class vocabulary (the contract)

Structure notes: every shell is `<div class="shell-*">` containing `<a class="skip-link" href="#main">`, a
`<header class="shell-header"><div class="shell-bar">...`, an optional `<nav class="shell-rail">` (admin only),
`<main id="main" class="shell-main" tabindex="-1">` and `<footer class="shell-footer">`. `.shell-bar`, `.container` give the
width/gutter. Only one `<h1>` per page.

### Accessibility helpers
* `.skip-link` - `<a class="skip-link" href="#main">Skip to main content</a>` (first element in the shell; shows on focus).
* `.visually-hidden` - `<span class="visually-hidden">(completed)</span>`.
* `.icon` - `<Check className="icon" aria-hidden="true" />` 1.25em lucide slot; inherits colour. Decorative icons are `aria-hidden`.
* `.no-print` - hide on print (receipt pages hide header/nav/footer/`.actions` automatically).

### Layout primitives
* `.container` (+ `.container-narrow` 34rem form width, `.container-wide` 100rem) - `<div class="container">` page width and gutter.
* `.stack` (+ `.stack-sm`, `.stack-lg`) - vertical rhythm: `<div class="stack">...</div>`.
* `.cluster` (+ `.cluster-between`, `.cluster-end`) - wrapping row: `<div class="cluster">` badges/links.
* `.grid-auto` - responsive equal columns for form fields: `<div class="grid-auto">`.
* `.actions` (+ `.actions-end`, `.actions-between`) - button row: `<div class="actions"><button class="btn btn-primary">...`.
* `.page-head` - `<div class="page-head"><p class="eyebrow">..</p><h1 class="h1">..</h1><p class="lede">..</p></div>`.
* `.section` - hairline-separated page region: `<section class="section"><h2 class="h2">..`.
* `.panel` - the one permitted surface box: `<div class="panel">` (use sparingly, never nested).
* `.prose` - long copy, 66ch: `<div class="prose"><h2>..</h2><p>..</p></div>`.

### Shells and parts
* `.shell-public`, `.shell-kiosk`, `.shell-admin` - outermost element of each context.
* `.shell-header` (white, 2px ink bottom rule; hairline in kiosk), `.shell-bar` (inner row), `.shell-brand` (+ `.brand-mark`), `.shell-nav` (`<ul>`), `.shell-link` (`aria-current="page"` marks current), `.shell-meta` (right-aligned header slot), `.shell-main`, `.shell-footer` (kiosk: pinned action bar; admin: bottom of work area), `.shell-rail` (admin `<nav aria-label="Administration">`).
* Example: `<a class="shell-brand" href="/"><span class="brand-mark" aria-hidden="true"></span>VoteChain</a>`; `<a class="shell-link" aria-current="page" href="/">Election</a>`.

### Typography
* `.h-display` (page opener, public only), `.h1`, `.h2`, `.h3` (sans), `.eyebrow` (small caps label above a heading), `.lede` (intro sentence), `.muted` (secondary text), `.mono` (hashes/ids/codes), `.tabular` (aligned numerals).
* Example: `<code class="mono">0x9f3a...</code>`, `<p class="eyebrow">General election 2026</p><h1 class="h1">Results</h1>`.
* Class use is independent of element: pick the element for document outline, the class for look.

### Buttons
* `.btn` (always) + one of `.btn-primary` (one per screen), `.btn-secondary`, `.btn-danger`, `.btn-quiet`; sizes `.btn-sm`, `.btn-lg` (kiosk), `.btn-block`.
* `<button class="btn btn-primary btn-lg" type="button">Continue</button>`.
* Disabled: native `disabled` or `aria-disabled="true"` (dashed outline, sunken fill, not-allowed cursor). Busy: `aria-busy="true"` (or `.is-busy`) shows a ring and blocks repeat presses; change the label too: `<button class="btn btn-primary" aria-busy="true">Saving...</button>`.
* Links that act as buttons: `<Link class="btn btn-secondary">`. Icon-only buttons need `aria-label`.

### Forms
* `.field` (label + control + hint + error stack), `.label` (above the control), `.hint`, `.input` (also `<textarea>`), `.select`, `.check` (checkbox row; whole row clickable), `.checkbox` (native, accent coloured), `.field-error` (text with a "!" square marker).
* `<div class="field"><label class="label" for="id">Voter ID</label><input id="id" class="input mono" aria-describedby="id-hint id-err" aria-invalid="true"><p class="hint" id="id-hint">..</p><p class="field-error" id="id-err">Enter the 10-character ID printed on your card.</p></div>`.
* Invalid state: `aria-invalid="true"` gives a thicker danger border; the `.field-error` text states the problem and the fix. On submit, focus the first invalid control. Set `autocomplete`, `name`, correct `type`/`inputmode`, `spellCheck={false}` for ids/codes; never block paste.

### Choice list (candidate selection; native fieldset/legend/radio)
* `.choice-list` (the `<fieldset>`; its `<legend>` is styled automatically), `.choice` (the row `<label>`), `.choice-input` (native radio), `.choice-body`, `.choice-name`, `.choice-meta`, `.choice-state` (the visible word "Selected", shown only when checked).
```html
<fieldset class="choice-list"><legend>Choose one candidate</legend>
  <label class="choice"><input class="choice-input" type="radio" name="candidate" value="1">
    <span class="choice-body"><span class="choice-name">Mira Anand</span><span class="choice-meta">Civic Renewal Party</span></span>
    <span class="choice-state">Selected</span></label>
  ...
</fieldset>
```
Min row height 56px (kiosk 72px). Selected = filled radio + accent border + tint + bold + "Selected" + tick. Disabled rows are dashed and sunken. Keep the `Selected` span in every row. Use `<label>` wrapping so there is no dead zone.

### Status
* `.status` + `.status-neutral | -info | -ok | -warn | -danger`; `.status-lg`; phases `.phase-setup | .phase-open | .phase-closed` (combine with `.status`); `.phase-banner` (with a `.phase-*`).
* `<span class="status status-ok">Confirmed</span>`, `<span class="status status-lg phase-open">Open</span>`, `<div class="phase-banner phase-closed" role="status">Voting has closed.</div>`.
* A glyph shape is drawn automatically; to use a lucide icon instead, add `<Icon class="icon" aria-hidden>` as the first child (the shape hides itself).

### Alerts
* `.alert` + `.alert-info | -ok | -warn | -danger`, `.alert-title`.
* `<div class="alert alert-danger" role="alert"><div><p class="alert-title">Receipt not found</p><p>No ballot matches this hash. Check for typing errors.</p></div></div>`
* Roles: **`role="alert"`** for blocking errors that appear after an action; **`role="status"`** for ok/info/warn that appear dynamically; **no role** for static notices rendered with the page. Always give a title word plus the next step.

### Tables
* `.table-wrap` (scroll container) > `.table`; `.table-sticky` (on the wrap, sticky header, 70dvh max), `.table-dense`, `.num` on numeric `<th>/<td>` (right-aligned, tabular).
* `<div class="table-wrap" tabindex="0" role="region" aria-label="Voters"><table class="table"><caption class="visually-hidden">Voters</caption><thead>..`
* Always `<th scope>`; identifiers in `<td class="mono">`. The wrap needs `tabindex="0"` + label so keyboard users can scroll it. Row hover is a faint tint; no striping.

### Definition lists and summary
* `.dl` > `.dl-row` > `<dt>` + `<dd>` (term column 13rem, stacks under 40rem). `<dl class="dl"><div class="dl-row"><dt>Transaction</dt><dd class="mono">0x..</dd></div></dl>`.
* `.summary` - ruled key/value strip, `<dl class="summary"><div><dt>Ballots recorded</dt><dd>3,412</dd></div>...</dl>`. 3-4 facts at most.
* `.receipt` - dashed stub wrapping a `.dl`. `.ballot` / `.ballot-head` / `.ballot-body` - the ballot sheet wrapping a `.choice-list`.

### Dialog
* `.dialog` on a native `<dialog>` opened with `showModal()` (focus trap, Esc, inert background, `::backdrop` scrim are native); `.dialog-actions`.
* `<dialog class="dialog" aria-labelledby="t"><h2 class="h2" id="t">Cast your vote?</h2><p>..</p><div class="dialog-actions"><button class="btn btn-secondary">Go back</button><button class="btn btn-primary">Cast vote</button></div></dialog>`.
* Body scroll is locked while open. Return focus to the trigger on close. Destructive confirmation names the object and the consequence.

### States
* `.state` (+ `.state-title`, `.state-body`, `.state-actions`, `.state-error`, `.state-loading`), `.skeleton`, `.spinner`.
* Empty: `<div class="state"><p class="state-title">No candidates yet</p><p class="state-body">Add the first candidate for this constituency.</p><div class="state-actions"><a class="btn btn-primary" ..>Add candidate</a></div></div>`.
* Loading (preferred, calm): `<div class="state state-loading" role="status"><span class="spinner" aria-hidden="true"></span>Loading...</div>` (always with words); `.skeleton` placeholders are static blocks (size with utilities `w-1/2`, `h-4`). Error: `.state.state-error` with `role="alert"` and a retry action.

### Stepper (kiosk progress)
* `.stepper` (`<ol aria-label="Voting progress">`) > `.step` + `.is-done | .is-current` (also set `aria-current="step"`) > `.step-num` + `.step-label`.
* Done = filled accent, current = bold + heavy ink outline, upcoming = dashed. Add `<span class="visually-hidden">(completed)</span>` text. On phones only the current label is shown.

### Countdown
* `.countdown` > `.countdown-label`, `.countdown-time` (mono, tabular), `.countdown-bar` > `<span style="--value:55%">`; `.is-urgent` adds danger colour, heavy border and a triangle glyph.
* Do not put `aria-live` on the ticking element. Mirror thresholds into a hidden live region.

### Bar (results)
* `.bar` > `.bar-fill`: `<div class="bar" role="img" aria-label="Mira Anand, 41.2 percent"><span class="bar-fill" style="--value:41.2%"></span></div>`. Always show the number and count in an adjacent cell.

### Toolbar, pager
* `.toolbar` (+ `.toolbar-end` pushes an item right), `.pager` > `.pager-info` + `.pager-nav`. Filters/page/sort live in the URL (query params).

## 7. Accessibility rules

* WCAG 2.2 AA minimum; all colour pairs are in section 1. Text 4.5:1, UI 3:1.
* Every interactive element shows the 3px ink focus ring on `:focus-visible`; do not add `outline: none`. Sticky bars
  must not hide focus (`scroll-padding-top` accounts for the header; the kiosk action bar is in-flow-sticky).
* Skip link first on every page; one `<main id="main">`; headings are hierarchical; route changes move focus to the
  new `<h1>` (`tabindex="-1"`) and update `document.title`.
* Landmarks: `header`, `nav` (labelled), `main`, `footer`. Native elements first (`button`, `a`, `label`, `fieldset`,
  `dialog`, `table`), ARIA only to fill gaps. Buttons act, links navigate.
* State is never colour alone: text + shape (glyphs, dashed/solid/filled borders, weights). Colour reinforces.
* Forms: visible `<label for>`, hint and error linked with `aria-describedby`, `aria-invalid`, inline errors, focus
  first error, specific button labels ("Verify receipt", not "Submit").
* Async updates: `role="status"` (polite) or `role="alert"` (assertive) as in section 6; loading text ends with an
  ellipsis; never announce a ticking countdown every second.
* Touch targets >= 44px everywhere, >= 56px for ballot rows and kiosk buttons; spacing between adjacent targets >= 8px.
* `prefers-reduced-motion` honoured (tokens + base rule); no autoplay; no parallax; no content that appears only on hover.
* Light theme only: `color-scheme: light` is declared so native controls and scrollbars match. `forced-colors` mode keeps
  borders and the focus ring (Highlight).
* Language: `<html lang="en">`; wrap identifiers in `translate="no"`. Use `Intl` for dates/numbers.
* Images need `alt` (or `alt=""`); lucide icons are `aria-hidden` unless they are the only label, in which case the
  button has an `aria-label`.
* Long content: text containers wrap (`overflow-wrap: anywhere` on `.mono`, `dd`, `.choice-name`); flex children have `min-width: 0`.

## 8. Anti-generic checklist (review every screen against this)

- [ ] No more than one accent colour on a screen; OK/danger/warn used only for their meanings.
- [ ] No boxes inside boxes; sections divided by rules and space; `.panel` used at most once per screen.
- [ ] No gradient, shadow (other than dialog scrim), glass, blur, glow, neon, or radius over 4px.
- [ ] No KPI tile grid, decorative chart, or stat that is not decision-relevant. `.summary` has <= 4 facts.
- [ ] Headline says what the page is for; no oversized hero; no marketing copy ("seamless", "next-gen", "unleash").
- [ ] Election phase visible (word + glyph + fill) on admin, kiosk, and public election pages.
- [ ] Hashes, ids, nullifiers, addresses in `.mono`; numbers tabular; long values wrap.
- [ ] Every status is text + shape; every icon is `aria-hidden` and sits beside text.
- [ ] Copy: sentence/Title Case consistent, active voice, specific button labels, errors say how to fix.
- [ ] No crypto/DeFi styling (no coin icons, wallets, gradients, dark neon, "Web3" wording). Wallet/chain details appear only as monospace data.
- [ ] Every interactive element tabbable with a visible ring; kiosk rows >= 56px; works at 1024x768 and 390px.
- [ ] Empty, loading, error and disabled states exist for every data region and form.
- [ ] No external fonts, scripts, images or analytics; no emoji as icons.
- [ ] Honest scope: nothing on screen claims secrecy, coercion resistance or voter anonymity beyond what the receipt docs state.

## 9. Notes for implementers

* Breakpoints are literal in `components.css` (`40rem`, `60rem`); use Tailwind `sm:` (40rem) and `lg:` (64rem) sparingly.
* `.shell-*` tokens are re-declared on the shell element; do not wrap a kiosk screen inside a public shell.
* Load order matters: `tailwindcss` first, then tokens, then components (components live in `@layer components`, so Tailwind utilities still override them).
* tokens.css is valid plain CSS followed by `@theme` blocks, so a static HTML preview using only the two files still renders; verified by building the real Tailwind v4 pipeline with Vite in a scratch project (not in the repo) and screenshotting at 1024x768, 1280x800 and 390x844 (no horizontal page overflow).
* Verified behaviours: native `:has()` is used for selected/focused choice rows and `@supports` guards the focus relocation; `content: "!" / ""` alt-text syntax is used for the error marker with a plain fallback.
* Not installed / not claimed: "Awesome Design" tooling was not used. The layout and guideline rules came from the two installed design skills and the Web Interface Guidelines (focus-visible, reduced motion, `touch-action`, `tabular-nums`, `text-wrap`, no `transition: all`, `overscroll-behavior` in dialogs, explicit select colours).
