(() => {
  "use strict";

  const commands = {
    unix: 'curl -fsSL "https://raw.githubusercontent.com/Alishahryar1/free-claude-code/main/scripts/install.sh" | sh',
    windows: '& ([scriptblock]::Create((irm "https://raw.githubusercontent.com/Alishahryar1/free-claude-code/main/scripts/install.ps1")))',
  };
  const tabs = [...document.querySelectorAll(".platform-tab")];
  const panel = document.getElementById("install-panel");
  const command = document.getElementById("install-command");
  const status = document.getElementById("copy-status");

  function selectPlatform(tab) {
    tabs.forEach((item) => {
      const selected = item === tab;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", tab.id);
    command.textContent = commands[tab.dataset.platform];
    status.textContent = "";
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectPlatform(tab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      next.focus();
      selectPlatform(next);
    });
  });

  document.getElementById("copy-command").addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(command.textContent);
      status.textContent = "Command copied.";
    } catch {
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(command);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      status.textContent = "Could not copy automatically. Select and copy the command above.";
    }
  });

  const mobileMenu = document.querySelector(".mobile-nav");
  mobileMenu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => { mobileMenu.open = false; });
  });
})();

(() => {
  "use strict";

  const apiBase = "https://openrouter.ai/api/v1";
  const maxToolRounds = 5;
  const maxToolCalls = 12;
  const tools = [
    {
      type: "function",
      function: {
        name: "calculate",
        description: "Perform arithmetic with two numbers.",
        parameters: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["add", "subtract", "multiply", "divide"] },
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["operation", "a", "b"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_current_time",
        description: "Get the current date and time in UTC.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "format_json",
        description: "Validate and format a JSON string.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "JSON to format." } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    },
  ];
  const toolLabels = {
    calculate: "Calculator",
    get_current_time: "UTC clock",
    format_json: "JSON formatter",
  };
  const keyInput = document.getElementById("router-key");
  const modelSelect = document.getElementById("free-model");
  const modelStatus = document.getElementById("model-status");
  const refreshButton = document.getElementById("refresh-models");
  const chatLog = document.getElementById("chat-log");
  const chatForm = document.getElementById("chat-form");
  const messageInput = document.getElementById("chat-message");
  const chatStatus = document.getElementById("chat-status");
  const sendButton = document.getElementById("send-chat");
  const stopButton = document.getElementById("stop-chat");
  const clearButton = document.getElementById("clear-chat");
  const conversations = new Map();
  let models = new Map();
  let pending = [];
  let busy = false;
  let refreshing = false;
  let activeRequest = null;

  function isZeroPrice(value) {
    return (typeof value === "number" || (typeof value === "string" && value.trim() !== ""))
      && Number.isFinite(Number(value)) && Number(value) === 0;
  }

  function isFreeToolModel(model) {
    if (!model || typeof model.id !== "string" || !model.id.trim()) return false;
    if (model.id !== "openrouter/free" && !model.id.endsWith(":free")) return false;
    const pricing = model.pricing;
    if (!pricing || !isZeroPrice(pricing.prompt) || !isZeroPrice(pricing.completion)) return false;
    for (const field of ["request", "internal_reasoning", "input_cache_read", "input_cache_write"]) {
      if (pricing[field] != null && !isZeroPrice(pricing[field])) return false;
    }
    if (pricing.overrides != null && (!Array.isArray(pricing.overrides) || pricing.overrides.length)) return false;
    if (!Array.isArray(model.supported_parameters) || !model.supported_parameters.includes("tools")) return false;
    const architecture = model.architecture;
    for (const field of ["input_modalities", "output_modalities"]) {
      const modalities = architecture?.[field];
      if (Array.isArray(modalities) && !modalities.includes("text")) return false;
    }
    return true;
  }

  function updateControls() {
    const available = models.has(modelSelect.value);
    modelSelect.disabled = busy || refreshing || !models.size;
    refreshButton.disabled = busy || refreshing;
    keyInput.disabled = busy;
    messageInput.disabled = busy || refreshing || !available;
    sendButton.disabled = busy || refreshing || !available || !keyInput.value.trim() || !messageInput.value.trim();
    clearButton.disabled = busy || refreshing || !(conversations.get(modelSelect.value)?.messages.length);
    stopButton.hidden = !busy;
  }

  function renderChat() {
    const transcript = conversations.get(modelSelect.value)?.transcript || [];
    const entries = [...transcript, ...pending];
    chatLog.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "chat-empty";
      empty.textContent = "Your conversation appears here. Try asking the model to use a calculator, check the time, or format JSON.";
      chatLog.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const item = document.createElement("div");
      item.className = `chat-entry chat-entry-${entry.kind}`;
      const label = document.createElement("p");
      label.className = "chat-entry-label";
      label.textContent = entry.label;
      const content = document.createElement("p");
      content.className = "chat-entry-content";
      content.textContent = entry.content;
      item.append(label, content);
      chatLog.appendChild(item);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  async function responseJson(response, key = "") {
    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (error.name === "AbortError") throw error;
      if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}.`);
      throw new Error("OpenRouter returned an invalid response.");
    }
    if (!response.ok || data?.error) {
      const raw = typeof data?.error?.message === "string" ? data.error.message : "";
      const detail = (key ? raw.split(key).join("[redacted]") : raw).replace(/\s+/g, " ").slice(0, 300);
      throw new Error(`OpenRouter returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
    }
    return data;
  }

  function setModelOptions(available, selected) {
    modelSelect.replaceChildren();
    if (!available.size) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No free models available";
      modelSelect.appendChild(option);
      return;
    }
    for (const model of available.values()) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = typeof model.name === "string" && model.name.trim()
        ? `${model.name} (${model.id})`
        : model.id;
      modelSelect.appendChild(option);
    }
    modelSelect.value = available.has(selected)
      ? selected
      : (available.has("openrouter/free") ? "openrouter/free" : available.keys().next().value);
  }

  async function refreshModels() {
    if (busy || refreshing) return;
    const selected = modelSelect.value;
    refreshing = true;
    modelStatus.textContent = "Loading the free model catalog...";
    updateControls();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${apiBase}/models`, {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      const data = await responseJson(response);
      if (!Array.isArray(data?.data)) throw new Error("OpenRouter returned an invalid model catalog.");
      const available = data.data.filter(isFreeToolModel)
        .sort((a, b) => a.id.localeCompare(b.id));
      models = new Map(available.map((model) => [model.id, model]));
      setModelOptions(models, selected);
      modelStatus.textContent = models.size
        ? `${models.size} free tool-capable model${models.size === 1 ? "" : "s"} available.`
        : "No free tool-capable models are currently listed. Try refreshing later.";
      renderChat();
    } catch (error) {
      models = new Map();
      setModelOptions(models, "");
      renderChat();
      modelStatus.textContent = controller.signal.aborted
        ? "Loading models timed out. Check your connection and refresh."
        : (error instanceof TypeError
          ? "Could not reach OpenRouter. Check your connection and refresh."
          : `${error.message} Refresh to try again.`);
    } finally {
      clearTimeout(timeout);
      refreshing = false;
      updateControls();
    }
  }

  function runTool(call) {
    const raw = call.function.arguments;
    if (raw.length > 20000) return { error: "Tool arguments are too large." };
    let args;
    try {
      args = JSON.parse(raw);
    } catch {
      return { error: "Tool arguments must be valid JSON." };
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { error: "Tool arguments must be a JSON object." };
    }
    if (call.function.name === "get_current_time") {
      return { utc: new Date().toISOString() };
    }
    if (call.function.name === "calculate") {
      const { operation, a, b } = args;
      if (!Number.isFinite(a) || !Number.isFinite(b)) return { error: "a and b must be finite numbers." };
      let result;
      if (operation === "add") result = a + b;
      else if (operation === "subtract") result = a - b;
      else if (operation === "multiply") result = a * b;
      else if (operation === "divide" && b !== 0) result = a / b;
      else return { error: "Choose a valid operation and do not divide by zero." };
      return Number.isFinite(result) ? { result } : { error: "The result is not finite." };
    }
    if (call.function.name === "format_json") {
      if (typeof args.text !== "string" || args.text.length > 16000) {
        return { error: "text must be a JSON string of at most 16000 characters." };
      }
      try {
        const formatted = JSON.stringify(JSON.parse(args.text), null, 2);
        return formatted.length <= 20000
          ? { formatted }
          : { error: "Formatted JSON is too large." };
      } catch {
        return { error: "Could not parse or format the supplied JSON." };
      }
    }
    return { error: "Unknown tool." };
  }

  function responseText(message) {
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text).join("");
    }
    return typeof message.refusal === "string" ? message.refusal : "";
  }

  async function runTurn(model, key, messages, signal) {
    let totalCalls = 0;
    for (let round = 0; round <= maxToolRounds; round += 1) {
      const response = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages,
          tools,
          provider: { require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0 } },
        }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      });
      const data = await responseJson(response, key);
      const choice = data?.choices?.[0];
      const message = choice?.message;
      if (!message || message.role !== "assistant") throw new Error("The model returned an invalid response.");
      const calls = message.tool_calls;
      if (calls != null && !Array.isArray(calls)) throw new Error("The model returned invalid tool calls.");
      const text = responseText(message);
      if (!calls?.length) {
        if (!text.trim()) throw new Error("The model returned no text. Try a shorter message or another model.");
        messages.push(message);
        pending.push({ kind: "assistant", label: "Assistant", content: text });
        return choice.finish_reason === "length";
      }
      if (round === maxToolRounds || totalCalls + calls.length > maxToolCalls) {
        throw new Error("The model exceeded the tool-call limit. Try a simpler request.");
      }
      const ids = new Set();
      for (const call of calls) {
        if (!call || call.type !== "function" || typeof call.id !== "string" || !call.id
          || ids.has(call.id) || typeof call.function?.name !== "string"
          || typeof call.function?.arguments !== "string") {
          throw new Error("The model returned invalid tool calls.");
        }
        ids.add(call.id);
      }
      messages.push(message);
      if (text.trim()) pending.push({ kind: "assistant", label: "Assistant", content: text });
      for (const call of calls) {
        const result = runTool(call);
        const content = JSON.stringify(result);
        messages.push({ role: "tool", tool_call_id: call.id, content });
        pending.push({
          kind: "tool",
          label: Object.hasOwn(toolLabels, call.function.name) ? toolLabels[call.function.name] : "Unknown tool",
          content: content.length > 1200 ? `${content.slice(0, 1200)}...` : content,
        });
      }
      totalCalls += calls.length;
      chatStatus.textContent = "Tool result ready. Waiting for the model...";
      renderChat();
    }
    throw new Error("The model exceeded the tool-call limit.");
  }

  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const model = modelSelect.value;
    const key = keyInput.value.trim();
    const text = messageInput.value.trim();
    if (busy || refreshing || !models.has(model) || !key || !text) return;
    const conversation = conversations.get(model) || { messages: [], transcript: [] };
    const messages = [...conversation.messages, { role: "user", content: text }];
    pending = [{ kind: "user", label: "You", content: text }];
    messageInput.value = "";
    busy = true;
    activeRequest = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      activeRequest.abort();
    }, 120000);
    chatStatus.textContent = "Waiting for the model...";
    updateControls();
    renderChat();
    try {
      const incomplete = await runTurn(model, key, messages, activeRequest.signal);
      conversation.messages = messages;
      conversation.transcript.push(...pending);
      conversations.set(model, conversation);
      chatStatus.textContent = incomplete
        ? "The model stopped at its output limit; the answer may be incomplete."
        : "Ready. You can continue this conversation.";
    } catch (error) {
      messageInput.value = text;
      chatStatus.textContent = activeRequest.signal.aborted
        ? (timedOut ? "Request timed out. Your message is ready to retry." : "Request stopped. Your message is ready to retry.")
        : (error instanceof TypeError
          ? "Could not reach OpenRouter. Check your connection and try again."
          : error.message);
    } finally {
      clearTimeout(timeout);
      activeRequest = null;
      pending = [];
      busy = false;
      renderChat();
      updateControls();
    }
  });

  refreshButton.addEventListener("click", refreshModels);
  modelSelect.addEventListener("change", () => {
    chatStatus.textContent = "Model selected. Conversations stay separate for each model.";
    renderChat();
    updateControls();
  });
  keyInput.addEventListener("input", updateControls);
  messageInput.addEventListener("input", updateControls);
  stopButton.addEventListener("click", () => activeRequest?.abort());
  clearButton.addEventListener("click", () => {
    conversations.delete(modelSelect.value);
    chatStatus.textContent = "New chat started.";
    renderChat();
    updateControls();
  });
  renderChat();
  updateControls();
  refreshModels();
})();
