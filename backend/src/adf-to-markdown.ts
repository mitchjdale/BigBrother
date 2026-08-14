/**
 * Minimal Atlassian Document Format (ADF) → Markdown converter.
 *
 * JIRA Cloud REST v3 returns rich-text fields (e.g. issue description) as ADF
 * JSON rather than Markdown. We convert the common node/mark types so the plan
 * prompt and the UI render readable Markdown. Unknown nodes fall back to their
 * text content, so nothing is lost even if a node type isn't handled.
 */

interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  marks?: AdfMark[];
  attrs?: Record<string, unknown>;
}

function applyMarks(text: string, marks: AdfMark[] | undefined): string {
  if (!marks?.length) return text;
  let out = text;
  for (const mark of marks) {
    switch (mark.type) {
      case "strong":
        out = `**${out}**`;
        break;
      case "em":
        out = `*${out}*`;
        break;
      case "code":
        out = `\`${out}\``;
        break;
      case "strike":
        out = `~~${out}~~`;
        break;
      case "link": {
        const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
        out = href ? `[${out}](${href})` : out;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function renderInline(nodes: AdfNode[] | undefined): string {
  if (!nodes?.length) return "";
  return nodes
    .map((n) => {
      if (n.type === "text") return applyMarks(n.text ?? "", n.marks);
      if (n.type === "hardBreak") return "\n";
      if (n.type === "mention") {
        const label = typeof n.attrs?.text === "string" ? n.attrs.text : "";
        return label ? `@${label.replace(/^@/, "")}` : "";
      }
      if (n.type === "emoji") {
        return typeof n.attrs?.text === "string" ? n.attrs.text : "";
      }
      if (n.type === "inlineCard") {
        const url = typeof n.attrs?.url === "string" ? n.attrs.url : "";
        return url;
      }
      // Fallback: render any nested content inline.
      return renderInline(n.content);
    })
    .join("");
}

function renderList(node: AdfNode, ordered: boolean, depth: number): string {
  const items = node.content ?? [];
  const indent = "  ".repeat(depth);
  return items
    .map((item, idx) => {
      const marker = ordered ? `${idx + 1}.` : "-";
      const inner = (item.content ?? [])
        .map((child) => renderBlock(child, depth + 1))
        .join("\n")
        .trim();
      // Indent continuation lines under the list marker.
      const [first, ...rest] = inner.split("\n");
      const restIndented = rest.map((l) => `${indent}  ${l}`).join("\n");
      return `${indent}${marker} ${first}${restIndented ? `\n${restIndented}` : ""}`;
    })
    .join("\n");
}

function renderBlock(node: AdfNode, depth = 0): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content);
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return `${"#".repeat(level)} ${renderInline(node.content)}`;
    }
    case "bulletList":
      return renderList(node, false, depth);
    case "orderedList":
      return renderList(node, true, depth);
    case "codeBlock": {
      const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      const code = renderInline(node.content);
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }
    case "blockquote":
      return (node.content ?? [])
        .map((c) => renderBlock(c, depth))
        .join("\n")
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "rule":
      return "---";
    case "panel":
      return (node.content ?? []).map((c) => renderBlock(c, depth)).join("\n\n");
    case "table":
      return renderTable(node);
    case "mediaSingle":
    case "mediaGroup":
      return (node.content ?? [])
        .map((m) => {
          const alt = typeof m.attrs?.alt === "string" ? m.attrs.alt : "attachment";
          return `_[${alt}]_`;
        })
        .join(" ");
    default:
      return renderInline(node.content);
  }
}

function renderTable(node: AdfNode): string {
  const rows = node.content ?? [];
  const rendered: string[][] = rows.map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? []).map((c) => renderBlock(c)).join(" ").replace(/\n/g, " ").trim(),
    ),
  );
  if (rendered.length === 0) return "";
  const header = rendered[0];
  const sep = header.map(() => "---");
  const body = rendered.slice(1);
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(sep), ...body.map(line)].join("\n");
}

/** Convert an ADF document (or null) to a Markdown string. */
export function adfToMarkdown(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const root = doc as AdfNode;
  if (!Array.isArray(root.content)) return "";
  return root.content
    .map((n) => renderBlock(n))
    .filter((s) => s.trim().length > 0)
    .join("\n\n")
    .trim();
}
