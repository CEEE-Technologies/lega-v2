# LEGA branding implementation

Approved specification: the LEGA Branding and Navigation Plan in this chat.

## Deliverables

1. Reuse LEGA logo/background, replace all application-owned product branding and sample identities, retain internal identifiers and legal attribution.
2. Apply LEGA green/gold tokens to Blueprint and custom surfaces in light/dark mode. Default to light; persist explicit choices; keep payment pages light.
3. Mount a 48px company rail physically right on dashboard/preferences. Replace left company dropdown with LEGA navigation logo; retain tenant context and existing switching behavior.
4. Hide unconfigured website/docs/support links, load optional settings from root .env. Preserve tenant-owned branding and accounting records.
5. Verify theme behavior, company switching/layout, emails/PDFs, builds/types, visual screenshots, and residual branding audit.

## Fixed palette

Light: navigation #173D36; primary #1F6F5C; background #F7FAF8; cards #FFFFFF; text #17302B; muted #60736C; border #DCE6E1; secondary #E8F2EE; accent #AD6D0F; accent-soft #FFF0D4; danger #B83D4A.

Dark: background #0B1815; cards #11231E; navigation #0F2B25; primary #78C3AD; text #EDF6F2. Reuse supporting tokens from LEGA's globals.css.

## Compatibility and validation

Keep @bigcapital package names, DB/storage/auth IDs and API fields. No schema/data migrations. Keep existing 1100px minimum desktop layout and Noto Sans. LEGA source is read-only. Use neutral example.com contacts for samples. Invalid theme values default light; storage errors must not prevent boot. Both html/body classes must agree. Active/inactive/building/deleting companies cannot initiate invalid switches; cache clearing/reload remains in the existing hook.

Verification includes public/browser theme regressions, company rail and tenant-isolation flows, light/dark screenshots, generated email/PDF inspection, builds, typecheck, scoped lint, and a final independent review.
