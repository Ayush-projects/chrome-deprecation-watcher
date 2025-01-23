import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import * as cheerio from 'cheerio';

interface DeprecatedAPI {
  apiName: string;
  changeType: string;
  description: string;
}

// 1) A global decoration type for our inline warnings
const deprecationDecorationType = vscode.window.createTextEditorDecorationType({
  after: {
    margin: '0 0 0 1rem',
    color: '#f00',
    backgroundColor: 'rgba(255, 200, 200, 0.3)',
    border: '1px solid #f00',
    // contentText will be set dynamically
  }
});

export async function activate(context: vscode.ExtensionContext) {
  console.log('Extension "chrome-deprecation-watcher" is activating...');

  const releaseNotesURL = 'https://developer.chrome.com/release-notes/132';
  console.log(`Step A) Using releaseNotesURL = ${releaseNotesURL}`);

  const versionMatch = releaseNotesURL.match(/release-notes\/(\d+)/);
  const versionNumber = versionMatch ? versionMatch[1] : 'unknown';
  console.log(`Step B) Extracted versionNumber = ${versionNumber}`);

  const deprecations = await getOrCreateReleaseNotes(versionNumber, releaseNotesURL, context);

  // Register a diagnostic collection
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('chrome-deprecations');
  context.subscriptions.push(diagnosticCollection);

  // Listen for doc events
  vscode.workspace.onDidOpenTextDocument(
    doc => checkForDeprecations(doc, deprecations, diagnosticCollection),
    null,
    context.subscriptions
  );

  vscode.workspace.onDidChangeTextDocument(
    event => checkForDeprecations(event.document, deprecations, diagnosticCollection),
    null,
    context.subscriptions
  );

  // Check currently open docs
  vscode.workspace.textDocuments.forEach(doc => {
    checkForDeprecations(doc, deprecations, diagnosticCollection);
  });

  console.log('Extension "chrome-deprecation-watcher" finished activation steps.');
}

export function deactivate() {
  console.log('Extension "chrome-deprecation-watcher" is deactivating...');
}

/**
 * If we already have a JSON file, just load it. Otherwise fetch & parse notes.
 */
async function getOrCreateReleaseNotes(
  versionNumber: string,
  releaseNotesURL: string,
  context: vscode.ExtensionContext
): Promise<DeprecatedAPI[]> {
  const storagePath = context.globalStoragePath;
  console.log(`(getOrCreateReleaseNotes) Checking storage folder: ${storagePath}`);

  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true });
  }

  const filename = `chromeReleaseNotes_${versionNumber}.json`;
  const filePath = path.join(storagePath, filename);
  console.log(`(getOrCreateReleaseNotes) Potential local JSON file: ${filePath}`);

  if (fs.existsSync(filePath)) {
    console.log(`Found existing release notes file for version ${versionNumber}, reading...`);
    const existingData = fs.readFileSync(filePath, 'utf-8');
    try {
      const parsed = JSON.parse(existingData);
      console.log(`Successfully loaded JSON with ${parsed.length} items from ${filePath}.`);
      return parsed;
    } catch (err) {
      console.error('(getOrCreateReleaseNotes) Error parsing JSON:', err);
    }
  }

  console.log(`No valid existing file for version ${versionNumber}, fetching & parsing...`);
  const rawHTML = await fetchReleaseNotesHTML(releaseNotesURL);
  const extractedSections = parseHTMLwithCheerio(rawHTML);
  const newData = await parseReleaseNotesWithCopilot(extractedSections);

  fs.writeFileSync(filePath, JSON.stringify(newData, null, 2), 'utf8');
  console.log(`Saved data to: ${filePath}`);
  return newData;
}

// Fetch HTML
async function fetchReleaseNotesHTML(url: string): Promise<string> {
  const response = await axios.get(url);
  return response.data;
}

// Parse HTML
function parseHTMLwithCheerio(html: string): string[] {
  const $ = cheerio.load(html);
  const results: string[] = [];
  $('h3').each((_, element) => {
    const heading = $(element).text().trim();
    const content = $(element).nextUntil('h3').text().trim();
    results.push(`HEADING: ${heading}\nCONTENT: ${content}`);
  });
  return results;
}

// LLM call
async function parseReleaseNotesWithCopilot(sections: string[]): Promise<DeprecatedAPI[]> {
  // ...
  // same code from your snippet
  return [];
}

// 2) Updated checkForDeprecations with decorations
function checkForDeprecations(
  doc: vscode.TextDocument,
  deprecations: DeprecatedAPI[],
  collection: vscode.DiagnosticCollection
) {
  const text = doc.getText();
  const diagnostics: vscode.Diagnostic[] = [];
  const decorationOptions: vscode.DecorationOptions[] = [];

  for (const dep of deprecations) {
    const escaped = dep.apiName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'g');

    let match;
    while ((match = regex.exec(text)) !== null) {
      const startIndex = match.index;
      const endIndex = startIndex + dep.apiName.length;
      const range = new vscode.Range(
        doc.positionAt(startIndex),
        doc.positionAt(endIndex)
      );

      const diagMessage = `The API "${dep.apiName}" is marked as ${dep.changeType}. ${dep.description}`;
      diagnostics.push({
        severity: vscode.DiagnosticSeverity.Warning,
        range,
        message: diagMessage,
        source: 'Chrome Deprecation Watcher'
      });

      // Add an inline decoration
      decorationOptions.push({
        range,
        renderOptions: {
          after: {
            contentText: `[${dep.changeType}] ${dep.apiName}`
          }
        }
      });
    }
  }

  collection.set(doc.uri, diagnostics);

  // Apply decorations to the matching editor (if visible)
  const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === doc.uri.toString());
  if (editor) {
    editor.setDecorations(deprecationDecorationType, decorationOptions);
  }
}
