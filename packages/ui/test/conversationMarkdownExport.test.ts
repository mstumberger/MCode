import { describe, expect, it } from "vitest";
import {
  buildConversationMarkdownExport,
  sanitizeExportFileTitle,
  type ConversationExportLabels,
} from "../src/v4/conversationMarkdownExport.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

function buildLabels(): ConversationExportLabels {
  return {
    exportedAt: (time, turns) => `Exported ${time} / ${turns} turns`,
    turnHeading: (index, origin, time) => `Turn ${index} ${origin} ${time}`,
    originUser: "User",
    originGoalContinuation: "Goal",
    originBackgroundResult: "Background",
    originEditRerun: "EditRerun",
    originWorkflowLaunch: "Workflow",
    sectionUser: "User",
    sectionSystemInput: "SystemInput",
    sectionReasoning: "Reasoning",
    sectionAssistant: "Response",
    sectionToolCall: (name) => `Tool: ${name}`,
    workedFor: (duration) => `worked ${duration}`,
    durationMinutesSeconds: (minutes, seconds) => `${minutes}m${seconds}s`,
    durationSeconds: (seconds) => `${seconds}s`,
    attachment: (name, mime, sizeLabel) => `attachment ${name} ${mime} ${sizeLabel}`,
    screenshot: (index) => `shot-${index}`,
    imageUnavailable: "image unavailable",
    inputTruncated: "(input truncated)",
    toolFailedShort: (message) => `failed ${message}`,
  };
}

const baseRowFields = {
  rowId: 0,
  turnId: "turn-1",
  createdAt: 1_700_000_000_000,
  createdAtSeq: 0,
};

function buildConversationRows(): ConversationRow[] {
  return [
    {
      ...baseRowFields,
      rowId: 1,
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1_700_000_000_000,
      activeMs: 133_000,
    },
    {
      ...baseRowFields,
      rowId: 2,
      kind: "userInput",
      text: "帮我看看这个报错",
      origin: "realUser",
      attachments: [
        { ref: "zcode-attachment://img-1", fileName: "shot.png", mime: "image/png", bytes: 3 },
        { ref: "zcode-attachment://doc-1", fileName: "note.txt", mime: "text/plain", bytes: 12 },
      ],
    },
    {
      ...baseRowFields,
      rowId: 3,
      kind: "reasoning",
      // 空文本 reasoning 行：两种档位都与 UI render unit 一致地跳过。
      text: "   ",
      state: "complete",
    },
    {
      ...baseRowFields,
      rowId: 4,
      kind: "reasoning",
      text: "用户贴了报错截图，先读取附件再定位问题。",
      state: "complete",
      durationMs: 95_000,
    },
    {
      ...baseRowFields,
      rowId: 5,
      kind: "reasoning",
      text: "第二段思考：确认修复方案并复核。",
      state: "complete",
    },
    {
      ...baseRowFields,
      rowId: 6,
      kind: "toolCall",
      toolCallId: "call-1",
      toolName: "Bash",
      status: "success",
      inputText: "ls -la",
      output: { text: "```\ntotal 0\n```" },
    },
    {
      ...baseRowFields,
      rowId: 7,
      kind: "toolCall",
      toolCallId: "call-2",
      toolName: "mcp__node_repl__js",
      status: "success",
      inputText: "",
      display: {
        kind: "node_repl_images",
        images: [{ base64: "aGVsbG8=", mimeType: "image/png" }],
      },
    },
    {
      ...baseRowFields,
      rowId: 8,
      kind: "assistantText",
      text: '问题在 :zcode-file-citation{path="src/index.ts"} 这里。\n\n![alt](zcode-artifact://art-1)',
      state: "complete",
    },
  ];
}

const fakeReadAttachment = async (params: { ref: string }) => {
  if (params.ref.endsWith("img-1") || params.ref.endsWith("art-1")) {
    return { bytes: Uint8Array.from([1, 2, 3]), mediaType: "image/png" };
  }
  throw new Error("unexpected ref");
};

describe("conversationMarkdownExport", () => {
  it("导出收集器：提问/思考/工具/回复与图片内嵌齐全", async () => {
    const result = await buildConversationMarkdownExport(buildConversationRows(), {
      sessionId: "session-1",
      sessionTitle: "修复构建报错/第一轮",
      labels: buildLabels(),
      formatDateTime: (timestamp) => `T${timestamp}`,
      readAttachment: fakeReadAttachment,
      now: () => new Date(1_700_000_000_000),
    });

    const markdown = result.markdown;

    // 文件名清洗：非法字符替换、时间戳后缀。
    expect(result.suggestedName).toMatch(/^修复构建报错_第一轮-\d{8}-\d{4}\.md$/);
    expect(result.turnCount).toBe(1);

    // 轮头带工时；用户提问原文完整保留。
    expect(markdown.includes("worked 2m13s")).toBeTruthy();
    expect(markdown.includes("帮我看看这个报错")).toBeTruthy();

    // reasoning 全量导出：两段非空思考都在（full 档不做可见性过滤），含行级时长；
    // 空文本 reasoning 行被跳过。
    expect(markdown.includes("用户贴了报错截图")).toBeTruthy();
    expect(markdown.includes("第二段思考")).toBeTruthy();
    expect(markdown.includes("Reasoning（1m35s）")).toBeTruthy();
    expect((markdown.match(/### Reasoning/gu) ?? []).length).toBe(2);

    // 输出含 ``` 的工具调用必须换围栏字符，不能截断。
    expect(markdown.includes("~~~")).toBeTruthy();
    expect(markdown.includes("total 0")).toBeTruthy();

    // 图片按行序编号：用户附件（rowId 2）先于 node_repl 截图（rowId 7）。
    expect(markdown.includes("![shot-1](data:image/png;base64,AQID)")).toBeTruthy();
    expect(markdown.includes("![shot-2](data:image/png;base64,aGVsbG8=)")).toBeTruthy();

    // 非图片附件列出元信息。
    expect(markdown.includes("attachment note.txt text/plain")).toBeTruthy();

    // citation 指令替换为文件名；artifact 图片替换为 data URI。
    expect(markdown.includes("`index.ts`")).toBeTruthy();
    expect(markdown.includes("zcode-file-citation")).toBeFalsy();
    expect(markdown.includes("![alt](data:image/png;base64,AQID)")).toBeTruthy();
    expect(markdown.includes("zcode-artifact://art-1")).toBeFalsy();
  });

  it("导出收集器：无 readAttachment 时图片降级为占位且不失败", async () => {
    const result = await buildConversationMarkdownExport(buildConversationRows(), {
      sessionId: "session-1",
      sessionTitle: "",
      labels: buildLabels(),
      formatDateTime: (timestamp) => `T${timestamp}`,
    });

    expect(result.turnCount).toBe(1);
    expect(result.skippedImageCount).toBeGreaterThanOrEqual(2);
    expect(result.markdown.includes("image unavailable")).toBeTruthy();
    // 空标题回退 conversation；inline base64 截图仍然内嵌（不依赖 readAttachment）。
    expect(result.suggestedName).toMatch(/^conversation-\d{8}-\d{4}\.md$/);
    expect(result.markdown.includes("data:image/png;base64,aGVsbG8=")).toBeTruthy();
  });

  it("精简档：工具仅单行摘要，思考过程完全不导出", async () => {
    const result = await buildConversationMarkdownExport(buildConversationRows(), {
      sessionId: "session-1",
      sessionTitle: "修复构建报错",
      labels: buildLabels(),
      formatDateTime: (timestamp) => `T${timestamp}`,
      readAttachment: fakeReadAttachment,
      detailLevel: "concise",
    });

    const markdown = result.markdown;
    expect(result.suggestedName).toMatch(/-summary\.md$/u);

    // 工具调用退化为单行摘要：有输入首行；无输出围栏、无工具截图。
    expect(markdown.includes("- **Bash**：ls -la")).toBeTruthy();
    expect(markdown.includes("- **mcp__node_repl__js**")).toBeTruthy();
    expect(markdown.includes("~~~")).toBeFalsy();
    expect(markdown.includes("total 0")).toBeFalsy();
    expect(markdown.includes("base64,aGVsbG8=")).toBeFalsy();

    // 思考过程不导出：两段 reasoning 均缺席，无任何思考小节。
    expect(markdown.includes("用户贴了报错截图")).toBeFalsy();
    expect(markdown.includes("第二段思考")).toBeFalsy();
    expect((markdown.match(/### Reasoning/gu) ?? []).length).toBe(0);

    // 提问与回复正文保留；回复 artifact 图片仍内嵌（属于回复内容，非工具输出）。
    expect(markdown.includes("帮我看看这个报错")).toBeTruthy();
    expect(markdown.includes("`index.ts`")).toBeTruthy();
    expect(markdown.includes("![alt](data:image/png;base64,AQID)")).toBeTruthy();
  });

  it("文件名清洗：控制字符与保留名", () => {
    expect(sanitizeExportFileTitle('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(sanitizeExportFileTitle("   ")).toBe("conversation");
    expect(sanitizeExportFileTitle("任务 ")).toBe("任务");
  });
});
