/**
 * @fileoverview Model Context Protocol (MCP) stdio Server for Universal Agent Annotator (v0.1).
 *
 * Exposes multimodal tools to Claude Code, Cursor, Codex, Antigravity, Windsurf, etc.:
 *  - `get_latest_annotations`: Returns structured canonical text + paired untrusted-evidence
 *    ImageContent blocks (base64 PNG), and records `mcp_called` telemetry.
 *  - `list_annotation_batches`: Lists recent annotation batches.
 *  - `get_annotation_batch`: Fetches a specific annotation batch by ID.
 */

import readline from 'node:readline';
import { getFormatter } from '../../shared/src/formatter.js';
import { listSavedBatches, loadSavedBatch } from './storage.js';
import { trackEvent } from './telemetry.js';

export const MCP_TOOLS = [
  {
    name: 'get_latest_annotations',
    description:
      'Fetch the most recent UI annotation batch captured by the user in the browser or desktop. Defaults to include_images=false (structured code-locator text only, saving visual tokens). Use get_annotation_image or pass include_images=true only when visual/layout inspection is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        include_images: {
          type: 'boolean',
          default: false,
          description:
            'Include cropped annotated PNG screenshots as multimodal ImageContent blocks. Defaults to false to save tokens; set true or call get_annotation_image only when visual/layout inspection is needed.',
        },
        formatter: {
          type: 'string',
          enum: ['canonical'],
          default: 'canonical',
          description: 'Serialization strategy to use.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_annotation_image',
    description:
      'On-demand visual loader: fetch the cropped annotated PNG screenshot for a specific annotation (by 1-based index) when text selectors alone are insufficient (e.g., region selection, layout/overlap bugs, canvas/SVG).',
    inputSchema: {
      type: 'object',
      properties: {
        index: {
          type: 'integer',
          minimum: 1,
          description: '1-based annotation index (e.g. 1 for Annotation 1). If omitted, returns all images in the batch.',
        },
        batch_id: {
          type: 'string',
          description: 'Optional batchId. Defaults to the latest annotation batch if omitted.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_annotation_batches',
    description: 'List recent UI annotation batches captured by the user.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 10,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_annotation_batch',
    description:
      'Fetch a specific UI annotation batch by its batchId. Defaults to include_images=false to save tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        batch_id: {
          type: 'string',
          description: 'The batchId returned by list_annotation_batches.',
        },
        include_images: {
          type: 'boolean',
          default: false,
          description: 'Include cropped annotated PNG screenshots. Defaults to false.',
        },
      },
      required: ['batch_id'],
      additionalProperties: false,
    },
  },
];

/**
 * Execute an MCP tool call and return the MCP `CallToolResult` object.
 * @param {string} name
 * @param {Record<string, any>} [args={}]
 */
export function handleMcpToolCall(name, args = {}) {
  if (name === 'list_annotation_batches') {
    const limit = Number(args.limit) || 10;
    const batches = listSavedBatches(limit);
    trackEvent('mcp_called', {
      tool_name: 'list_annotation_batches',
      annotation_count: 0,
    });
    return {
      content: [
        {
          type: 'text',
          text: batches.length
            ? JSON.stringify(batches, null, 2)
            : 'No annotation batches have been captured yet. Press Alt+Shift+A (or click the Agent Annotator extension icon) in your browser to annotate UI elements.',
        },
      ],
    };
  }

  if (name === 'get_annotation_image') {
    const batch = args.batch_id ? loadSavedBatch(args.batch_id, { withImages: true }) : loadSavedBatch(undefined, { withImages: true });
    if (!batch) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: args.batch_id
              ? `Annotation batch "${args.batch_id}" not found.`
              : 'No annotation batch found.',
          },
        ],
      };
    }

    const formatter = getFormatter('canonical');
    const serialized = formatter.serialize(batch);
    const targetIdx = args.index !== undefined ? Number(args.index) : null;
    const selectedImages =
      targetIdx !== null
        ? serialized.images.filter((img) => img.commentIndex === targetIdx)
        : serialized.images;

    if (selectedImages.length === 0) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              targetIdx !== null
                ? `No screenshot found for Annotation ${targetIdx} in batch "${batch.batchId}".`
                : `No screenshots found in batch "${batch.batchId}".`,
          },
        ],
      };
    }

    /** @type {Array<{ type: string, text?: string, data?: string, mimeType?: string }>} */
    const content = [];
    for (const img of selectedImages) {
      if (img.base64Data) {
        content.push({
          type: 'text',
          text: img.promptText,
        });
        content.push({
          type: 'image',
          data: img.base64Data,
          mimeType: img.mimeType || 'image/png',
        });
      }
    }

    trackEvent('mcp_called', {
      tool_name: 'get_annotation_image',
      batch_id: batch.batchId,
      annotation_count: selectedImages.length,
      image_count: selectedImages.length,
      formatter: formatter.name,
    });

    return { content };
  }

  if (name === 'get_latest_annotations' || name === 'get_annotation_batch') {
    const batch = name === 'get_annotation_batch' ? loadSavedBatch(args.batch_id, { withImages: true }) : loadSavedBatch(undefined, { withImages: true });
    if (!batch) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              name === 'get_annotation_batch'
                ? `Annotation batch "${args.batch_id}" not found.`
                : 'No annotation batch found. Trigger the browser extension (Alt+Shift+A) to capture UI annotations first.',
          },
        ],
      };
    }

    const formatter = getFormatter(args.formatter || 'canonical');
    const serialized = formatter.serialize(batch);
    const includeImages = args.include_images === true;

    /** @type {Array<{ type: string, text?: string, data?: string, mimeType?: string }>} */
    const content = [
      {
        type: 'text',
        text: serialized.text,
      },
    ];

    let returnedImageCount = 0;
    if (includeImages) {
      for (const img of serialized.images) {
        if (img.base64Data) {
          content.push({
            type: 'text',
            text: img.promptText,
          });
          content.push({
            type: 'image',
            data: img.base64Data,
            mimeType: img.mimeType || 'image/png',
          });
          returnedImageCount += 1;
        }
      }
    }

    // Record North Star telemetry event: Agent consumed this annotation batch via MCP
    trackEvent('mcp_called', {
      tool_name: name,
      batch_id: batch.batchId,
      annotation_count: batch.items.length,
      image_count: returnedImageCount,
      formatter: formatter.name,
    });

    return { content };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
  };
}

/**
 * Start the JSON-RPC 2.0 stdio loop for MCP.
 */
export function startMcpStdioServer() {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      writeRpcError(null, -32700, 'Parse error');
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    // Notifications (no id) require no response
    if (msg.id === undefined) {
      return;
    }

    try {
      if (msg.method === 'initialize') {
        writeRpcResult(msg.id, {
          protocolVersion: msg.params?.protocolVersion || '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'agent-annotator',
            version: '0.1.0',
          },
        });
        return;
      }

      if (msg.method === 'ping') {
        writeRpcResult(msg.id, {});
        return;
      }

      if (msg.method === 'tools/list') {
        writeRpcResult(msg.id, {
          tools: MCP_TOOLS,
        });
        return;
      }

      if (msg.method === 'tools/call') {
        const result = handleMcpToolCall(msg.params?.name, msg.params?.arguments || {});
        writeRpcResult(msg.id, result);
        return;
      }

      writeRpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    } catch (err) {
      writeRpcError(msg.id, -32603, err instanceof Error ? err.message : String(err));
    }
  });
}

function writeRpcResult(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function writeRpcError(id, code, message) {
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    }) + '\n'
  );
}
