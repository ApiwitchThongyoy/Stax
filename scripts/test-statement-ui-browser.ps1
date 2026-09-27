# Start `npm run test:statement-ui` separately, then run this script.
# Actual React components + synthetic API responses only; no production DB.
$ErrorActionPreference = 'Stop'
function Browser {
  & npx.cmd --yes agent-browser @args
  if ($LASTEXITCODE -ne 0) { throw "Browser command failed: $args" }
}
function Assert-Browser([string] $code) {
  "(() => { $code })()" | & npx.cmd --yes agent-browser eval --stdin
  if ($LASTEXITCODE -ne 0) { throw 'Browser assertion failed' }
}
Browser open 'http://127.0.0.1:5191/scripts/fixtures/statement-ui/index.html'
Browser find text 'Fixture login' click
Browser wait '#trading-stock-search'
Browser click '#trading-stock-search'
Browser press A
Browser press A
Assert-Browser @'
const field = document.querySelector('#trading-stock-search');
if (field.value !== 'AA' || document.activeElement !== field) throw Error('Partial typing/focus failed');
if (!document.querySelector('#trading-stock-suggestions').textContent.includes('AAPL')) throw Error('No partial suggestion');
if (JSON.parse(document.querySelector('#requests').textContent).filter(url => url.includes('trading-journal')).length !== 1) throw Error('Per-keystroke network request');
window.fixtureSearchNode = field;
return 'PASS partial search, suggestions, retained focus, no per-keystroke requests';
'@
Browser press P
Browser press L
Assert-Browser @'
const field = document.querySelector('#trading-stock-search');
if (field.value !== 'AAPL' || document.activeElement !== field || field !== window.fixtureSearchNode) throw Error('Continuous typing/remount failed');
if (document.querySelectorAll('tbody tr').length !== 1) throw Error('Exact filtering failed');
return 'PASS continuous AAPL typing, stable input node, exact filtering';
'@
Browser fill '#trading-stock-search' 'AA'
Browser click '#stock-option-1 button'
Assert-Browser @'
const field = document.querySelector('#trading-stock-search');
if (field.value !== 'AAPL' || document.querySelector('[role=listbox]') || document.activeElement !== field) throw Error('Suggestion selection/focus failed');
return 'PASS suggestion selection';
'@
Browser find text 'Dashboard fixture' click
Browser wait 'h1'
Assert-Browser "if (!document.querySelector('h1').textContent.includes('fixture-user@example.test')) throw Error('Email fallback missing'); return 'PASS registered email fallback';"
Browser find text 'Import two documents' click
Assert-Browser "if (!document.querySelector('h1').textContent.includes('Mira Fixture') || !document.querySelector('#statement-account-details').textContent.includes('FIX1001')) throw Error('Document identity missing'); return 'PASS parsed document identity';"
Browser click 'button[aria-controls=statement-account-details]'
Assert-Browser "if (document.querySelector('#statement-account-details')) throw Error('Collapse failed'); return 'PASS identity-only disclosure';"
Browser click 'button[aria-controls=statement-account-details]'
Browser find text 'Delete one document' click
Assert-Browser "if (!document.querySelector('h1').textContent.includes('Mira Fixture')) throw Error('Remaining identity lost'); return 'PASS one deletion retains source identity';"
Browser find text 'Delete all documents' click
Assert-Browser "if (!document.querySelector('h1').textContent.includes('fixture-user@example.test') || document.querySelector('#statement-account-details')) throw Error('Stale identity'); return 'PASS final deletion clears identity';"
Assert-Browser "if (document.querySelector('button[aria-label]')) throw Error('Calendar button still present'); return 'PASS no extra calendar button';"
Browser find text 'ตัดยอด ณ วันที่' click
Browser click 'input[type=date]'
Browser press Escape
Assert-Browser "if (Number(document.querySelector('#picker-calls').textContent) < 1) throw Error('Picker not called'); return 'PASS clicking the date field invokes the native picker';"
Browser click 'input[type=date]'
Browser press ArrowRight
Browser press Enter
Assert-Browser "if (!document.querySelector('input[type=date]').value || !JSON.parse(document.querySelector('#requests').textContent).at(-1).includes('asOf=' + document.querySelector('input[type=date]').value)) throw Error('Stale date sent'); return 'PASS selected date reaches existing API filter';"
Browser find text 'Cash fixture' click
Browser find text 'ตัดยอด ณ วันที่' click
Browser click 'input[type=date]'
Browser press Escape
Browser click 'input[type=date]'
Browser press ArrowRight
Browser press Enter
Assert-Browser "if (!document.querySelector('input[type=date]').value || !JSON.parse(document.querySelector('#requests').textContent).at(-1).includes('asOf=' + document.querySelector('input[type=date]').value)) throw Error('Cash filter failed'); return 'PASS CashFlow native picker and state';"
Browser screenshot "$env:TEMP/stax-statement-ui-verified.png"
Browser errors
Write-Output 'STAX browser regressions: PASS'
