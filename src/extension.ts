import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import * as cheerio from 'cheerio';

interface DeprecatedAPI {
  apiName: string;   // e.g. "HTMLVideoElement", "navigator.storage", etc.
  changeType: string; // e.g. "Deprecated", "Removed", "Changed"
  description: string;
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('Extension "chrome-deprecation-watcher" is activating...');

  // Example release notes URL
  const releaseNotesURL = 'https://developer.chrome.com/release-notes/132';
  console.log(`Step A) Using releaseNotesURL = ${releaseNotesURL}`);

  // Extract the "132" from the URL for file naming
  const versionMatch = releaseNotesURL.match(/release-notes\/(\d+)/);
  const versionNumber = versionMatch ? versionMatch[1] : 'unknown';
  console.log(`Step B) Extracted versionNumber = ${versionNumber}`);

  // Attempt to load or create JSON for that version
  const deprecations = await getOrCreateReleaseNotes(versionNumber, releaseNotesURL, context);

  // Register a diagnostic collection for warnings
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('chrome-deprecations');
  context.subscriptions.push(diagnosticCollection);

  // Listen for doc events, check usage in real time
  vscode.workspace.onDidOpenTextDocument(
    doc => {
      console.log(`(EVENT) onDidOpenTextDocument: ${doc.fileName}`);
      checkForDeprecations(doc, deprecations, diagnosticCollection);
    },
    null,
    context.subscriptions
  );

  vscode.workspace.onDidChangeTextDocument(
    event => {
      console.log(`(EVENT) onDidChangeTextDocument: ${event.document.fileName}`);
      checkForDeprecations(event.document, deprecations, diagnosticCollection);
    },
    null,
    context.subscriptions
  );

  // Check currently open docs
  vscode.workspace.textDocuments.forEach(doc => {
    console.log(`(INIT) Checking already open doc: ${doc.fileName}`);
    checkForDeprecations(doc, deprecations, diagnosticCollection);
  });

  console.log('Extension "chrome-deprecation-watcher" finished activation steps.');
}

export function deactivate() {
  console.log('Extension "chrome-deprecation-watcher" is deactivating...');
}

/**
 * If we already have a JSON file for this version, just load it.
 * Otherwise, fetch the HTML, parse with Cheerio, call the LLM, then save a new JSON file.
 */
async function getOrCreateReleaseNotes(
  versionNumber: string,
  releaseNotesURL: string,
  context: vscode.ExtensionContext
): Promise<DeprecatedAPI[]> {
  const storagePath = context.globalStoragePath;
  console.log(`Step 1) Checking storage folder: ${storagePath}`);

  if (!fs.existsSync(storagePath)) {
    console.log(`Storage path does not exist, creating: ${storagePath}`);
    fs.mkdirSync(storagePath, { recursive: true });
  }

  const filename = `chromeReleaseNotes_${versionNumber}.json`;
  const filePath = path.join(storagePath, filename);
  console.log(`Step 2) Potential local JSON file: ${filePath}`);

  // Check if file already exists
  if (fs.existsSync(filePath)) {
    console.log(`Found existing release notes file for version ${versionNumber}, reading...`);
    const existingData = fs.readFileSync(filePath, 'utf-8');
    try {
      const parsed = JSON.parse(existingData);
      console.log(`Successfully loaded JSON with ${parsed.length} items from ${filePath}.`);
      // Return it directly, skipping LLM
      return parsed;
    } catch (err) {
      console.error('Error parsing existing JSON, ignoring and refetching:', err);
    }
  }

  console.log(`No valid existing file for version ${versionNumber}, will fetch & parse...`);

  // Step 1: Fetch HTML
  console.log(`Step 3) Fetching HTML from: ${releaseNotesURL}`);
  const rawHTML = await fetchReleaseNotesHTML(releaseNotesURL);
  console.log(`Fetched HTML length: ${rawHTML.length} characters.`);

  // Step 2: Extract text with Cheerio
  console.log('Step 4) Parsing fetched HTML with Cheerio...');
  const extractedSections = parseHTMLwithCheerio(rawHTML);
  console.log(`Cheerio extracted ${extractedSections.length} section(s).`);

  // Step 3: Use Copilot to transform into structured data
  console.log('Step 5) Invoking Copilot to interpret extracted text...');
  const newData = await parseReleaseNotesWithCopilot(extractedSections);
  console.log(`Copilot returned ${newData.length} item(s).`);

  // Step 4: Write to file for next time
  fs.writeFileSync(filePath, JSON.stringify(newData, null, 2), 'utf8');
  console.log(`Saved data to: ${filePath}`);

  return newData;
}

// ---------------------------------------------------------------------------
// Fetch HTML using axios
// ---------------------------------------------------------------------------
async function fetchReleaseNotesHTML(url: string): Promise<string> {
  console.log(`(fetchReleaseNotesHTML) Using axios to GET ${url}`);
  const response = await axios.get(url);
  console.log(`(fetchReleaseNotesHTML) Response status: ${response.status} ${response.statusText}`);
  return response.data; // raw HTML
}

// ---------------------------------------------------------------------------
// Parse HTML with Cheerio to get relevant text
// ---------------------------------------------------------------------------
function parseHTMLwithCheerio(html: string): string[] {
  console.log('(parseHTMLwithCheerio) Loading HTML into Cheerio...');
  const $ = cheerio.load(html);

  // For each <h3>, gather heading + subsequent text
  const results: string[] = [];

  $('h3').each((_, element) => {
    const heading = $(element).text().trim();
    const content = $(element).nextUntil('h3').text().trim();
    const combined = `HEADING: ${heading}\nCONTENT: ${content}`;
    results.push(combined);
  });

  console.log(`(parseHTMLwithCheerio) Found ${results.length} <h3> headings in total.`);
  return results;
}

// ---------------------------------------------------------------------------
// Use Copilot (GPT-4) to parse release notes text into { apiName, changeType, description }
// ---------------------------------------------------------------------------
async function parseReleaseNotesWithCopilot(sections: string[]): Promise<DeprecatedAPI[]> {
  console.log('(parseReleaseNotesWithCopilot) Starting LLM invocation for release notes.');

  // 1) Show an info message that we’re starting LLM interaction
  vscode.window.showInformationMessage('[LLM] Starting parse of release notes...');

  // 2) Select GPT-4 model explicitly
  console.log('(parseReleaseNotesWithCopilot) Selecting GPT-4 via family: gpt-4');
  const chatModels = await vscode.lm.selectChatModels({ family: 'gpt-4' });
  if (chatModels.length === 0) {
    vscode.window.showErrorMessage('No GPT-4 models found!');
    console.error('(parseReleaseNotesWithCopilot) No GPT-4 model available.');
    return [];
  }

  vscode.window.showInformationMessage('[LLM] GPT-4 model selected. Sending request...');
  console.log('(parseReleaseNotesWithCopilot) GPT-4 model selected, building user query.');

  // 3) Build the user query
  const combinedText = sections.join('\n\n');
  const userQuery = `
  You are given text extracted from Chrome release notes.
  Identify any deprecated or changed APIs and return them in a JSON array of objects,
  using the code block \`\`\`json ...\`\`\` format.
  Example:
  \`\`\`json
  [
    { "apiName": "...", "changeType": "...", "description": "..." },
    ...
  ]
  \`\`\`
  Here is the text:
  ${combinedText}
  `;

  // 4) Create the messages
  const messages = [vscode.LanguageModelChatMessage.User(userQuery)];

  // 5) Actually send the request to GPT-4
  console.log('(parseReleaseNotesWithCopilot) Sending request, streaming response...');
  const chatRequest = await chatModels[0].sendRequest(messages);

  let responseText = '';
  for await (const token of chatRequest.text) {
    responseText += token;
  }
  console.log('(parseReleaseNotesWithCopilot) LLM interaction complete, final response length:', responseText.length);

  // Show final user-facing message (optional)
  vscode.window.showInformationMessage('[LLM] Release notes parse complete.');

  // 6) Extract JSON from code block
  const jsonRegex = /```json([\s\S]*?)```/;
  const match = jsonRegex.exec(responseText);

  if (match && match[1]) {
    try {
      const parsed = JSON.parse(match[1]);
      console.log(`(parseReleaseNotesWithCopilot) Successfully parsed JSON with ${parsed.length} items.`);
      return parsed;
    } catch (err) {
      console.error('(parseReleaseNotesWithCopilot) Failed to parse JSON from Copilot:', err);
    }
  } else {
    console.error('(parseReleaseNotesWithCopilot) No JSON code block found in Copilot response.');
  }

  // Fallback: return empty array if something fails
  return [];
}

// ---------------------------------------------------------------------------
// Check code usage in a given document
// ---------------------------------------------------------------------------
function checkForDeprecations(
  doc: vscode.TextDocument,
  deprecations: DeprecatedAPI[],
  collection: vscode.DiagnosticCollection
) {
  console.log(`(checkForDeprecations) Checking doc: ${doc.fileName} with ${deprecations.length} deprecations...`);

  // Previously we skipped non-JS/TS, but now let's do them all (including CSS, HTML, etc.)
  // If you want to exclude certain file types, add checks here.

  const text = doc.getText();
  const diagnostics: vscode.Diagnostic[] = [];

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
      const message = `The API "${dep.apiName}" is marked as ${dep.changeType}. ${dep.description}`;
      diagnostics.push({
        severity: vscode.DiagnosticSeverity.Warning,
        range,
        message,
        source: 'Chrome Deprecation Watcher'
      });
    }
  }

  console.log(`(checkForDeprecations) Found ${diagnostics.length} matches in ${doc.fileName}.`);
  collection.set(doc.uri, diagnostics);
}
