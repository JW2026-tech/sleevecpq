# Sleeve CPQ — werkafspraken

CPQ-configurator (Configure Price Quote) van Sleeve Technology: **één framework-loos HTML-bestand** (`cpq-configurator.html`, ±1,2 MB, LF-regeleinden) plus twee kleine Vercel-functies in `api/`. Jeroen werkt in het Nederlands; de app, de klantdocumenten en de commitberichten zijn Engels of Nederlands, zoals het bestaande werk.

## Waar wat staat
- **Werkkopie:** `C:\Users\jeroen.weijers\cpq-app` (git, branch `main`). Git draait **niet** op `S:` (het IAMCloud-bestandssysteem mist een `stat`-aanroep). `S:\Sales\CPQ` bevat alleen de SQL-bestanden (`supabase-*.sql`), het migratieplan en oude mappen; daar niet bewerken.
- **GitHub:** `https://github.com/JW2026-tech/sleevecpq.git` → Vercel-project `cpq-configurator` (auto-deploy bij push op `main`, live op `https://cpq-configurator.vercel.app`).
- **Supabase:** project `tyjlhxrfgvqblfjmdxeq`. De URL en de anon-sleutel staan in de HTML (`SUPABASE_URL`); de veiligheid zit in de RLS-policies.
- **`api/render-pdf.js`:** rendert een offerte naar PDF met headless Chrome door de app te laden met `?render=1` en `window.__cpqRenderQuote(payload)` aan te roepen. Vercel-variabelen: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`. `GET ?check=1` toont wat de functie ziet (zonder sleutels).
- **`api/odoo-contacts.js`:** zoekt klanten in Odoo.
- **`sql/`:** SQL in de repo (nu `catalogue_draft_history.sql`); de oudere migraties staan in `S:\Sales\CPQ`.

## Werkwijze met git (belangrijk)
- Bewerk, controleer, **commit lokaal** (één commit per wijziging) en meld kort wat er is veranderd.
- **Push niet** tot Jeroen "push" zegt, of "push meteen" / "snel" bij het verzoek zelf. Elke push start een Vercel-deploy van 20–60 s. Bij "push": alles in één keer, één deploy afwachten, dan in één ronde live nameten.
- Live nameten vóór de push heeft geen zin (de gedeelde app draait dan nog de oude versie). Na de push blijft nameten staan bij geld, opslaan/persistentie en de klantlink.
- Blokkeert de auto-mode een `git push`, leg dat dan uit en geef Jeroen de exacte commando's.
- `core.autocrlf=true`: de waarschuwing "LF will be replaced by CRLF" is normaal.

## Nooit doen: de app openen tegen de live database
`SUPABASE_URL` en de anon-sleutel staan hard in de code en **TEST MODE** staat aan (zoek `TEMPORARY TEST MODE`, nu 3 plekken). Met die sleutel mag de app de gedeelde `catalogue_draft` schrijven, en `renderAdmin()` roept meteen `saveSoon()` aan. Het bestand openen (lokale server, browser-pane, waar dan ook) en `CONFIG` aanpassen **overschrijft binnen een seconde Jeroens echte catalogus** (gebeurd op 24-09 en op 2 en 3 nov 2026).
- Test daarom **headless**: functies uit het bestand knippen en in Node draaien (zie hieronder), of een browser-pane met een kopie waarin `SUPABASE_URL` onschadelijk is gemaakt vóór het laden.
- Voor weergave kun je een losse HTML maken met alleen de `<style>`-blokken uit het bestand en de HTML die een functie teruggeeft, zonder het app-script.

## Hoe je een wijziging controleert
1. **Syntaxis:** alle inline scripts uit het bestand halen (`<script>` zonder `src`) en door `new vm.Script(...)` halen.
2. **Gedrag:** een functie op het hoogste niveau uitsnijden (van `\nfunction naam(` tot de eerstvolgende `\n}\n`), in `vm` draaien met stubs voor wat ze aanroept (`esc`, `fmt`, `CONFIG`, …) en de uitkomst vergelijken met een vooraf uitgerekend getal. Echte gegevens uit een screenshot zijn de beste testinvoer.
3. **Stubs gelijk aan het echte gedrag:** bekijk de echte functie (bijvoorbeeld of ze `null` opvangt) voordat je een stub schrijft; een foute stub levert valse meldingen.
4. De testscripts horen niet in de repo; zet ze in de scratchpad.

## Hoe het bestand is opgebouwd
Genummerde delen: 2 ENGINE, 3 CONFIGURE VIEW, 4 ADMIN VIEW, 5 DOCUMENTS, 6 CHROME, 7 AUTO-SAVE; ertussen genoemde blokken (OPTION PROPERTIES, ALTERNATIVES SIDE BY SIDE, THE LANGUAGE OF A QUOTATION, THE QUOTE BAR, …). Zoek met `grep -n "^/\* ====" cpq-configurator.html`.
- **`CONFIG` en `state`.** `CONFIG` is de catalogus en de offerte-instellingen; `state` de keuzes in de offerte. Alles wat de app onthoudt staat op `CONFIG` en verlaat de browser alleen via `CATALOGUE_KEYS` (naar `catalogue_draft` en `catalogue_versions`) en `QUOTE_KEYS` (naar de offerte). Opslaan en publiceren lopen allebei door `cataloguePayload()`. Een sleutel op geen van beide lijsten bestaat voor niemand anders; `checkConfigKeys()` meldt dat in rood. `p.step` wordt bewust uit de opslag gestript (`catalogueForStorage()`).
- **Drie plekken tonen dezelfde alternatieven:** het salesraster op het tabblad Alternatives (`altsScreenHtml`), de PDF en het voorstel (`altCompareHtml`, via `proposalHtml` en `buildAllDocsHtml`) en de klantlink (`shareAltGroupHtml` met `shareAltCompareHtml`, `bootShareMode` voor `?share=<token>`). Rekenwerk dat ze delen staat in `altGridData`, `altPropCell` en `altUpgradesInScope`: pas dat aan op één plek, niet per weergave. Klantdocumenten rekenen prijzen met de korting van de offerte (`frac`), het salesscherm toont lijstprijzen.
- **Taal:** klantdocumenten bestaan in EN en ES. Een nieuwe vaste tekst in een klantdocument krijgt een regel in `I18N_ES` (of een patroon in de lijst eronder); wat geen Spaanse versie heeft blijft Engels.
- **De klantlink** heeft een eigen opmaak (vaste huisstijlkleuren, los van het thema van de kijker) en is alleen op het investeringsvoorstel interactief; keuzes gaan gedebounced terug via `update_shared_quote`.

## Supabase-valkuilen
- Een mislukte `supa.from(...)` **resolvet met een `error`**, hij gooit niet. Een `try/catch` vangt dus niets: controleer altijd `if(error) console.warn(...)`.
- Een verificatiequery op `pg_proc` zegt `true` voor een functie die niemand kan aanroepen; controleer ook `proargtypes`. Controleer bij nieuwe SQL de signatuur en de kolomnamen van bestaande tabellen (`quote_versions` heeft een bigint identity-id en `saved_at`/`saved_by`).
- De catalogus is gedeeld met collega's; schrijf alleen via de RPC's (`save_catalogue_draft`, `apply_catalogue_patches`, …) en neem bij een herstel de **huidige** draft als basis.

## Catalogus kwijt of teruggedraaid?
De tabel `catalogue_draft_history` houdt de laatste 40 kopieën bij (een per 10 minuten bewerken, plus een bij elke schrijfactie die de catalogus met meer dan 2% verkleint). Lees eerst (alleen GET) die tabel en `catalogue_draft`, vergelijk, en vraag Jeroens akkoord. Herstel met `save_catalogue_draft(p_data, p_rev = huidige rev)` en zet alleen terug wat weg is. Alle schrijfacties staan nu op `updated_by = "unknown"` omdat inloggen uit staat.

## Openstaand
- **TEST MODE terugdraaien** (revert-SQL onderaan `supabase-schema-testmode.sql` plus de `TEMPORARY TEST MODE`-plekken in de code) vóórdat een echte klant een link ziet of er klantdata in staat. Inloggen (Microsoft/Azure) is gepland voor woensdag 4 nov 2026.
- **"Send PDF by email"** werkt pas met een Azure AD-appregistratie; tot dan valt het terug op een lokale download.
- De wensenlijst van 24-09-2026 (zoekfunctie door de steps, ringsnijders, option properties in link/pdf, …): **niet oppakken tenzij Jeroen een punt noemt.**
