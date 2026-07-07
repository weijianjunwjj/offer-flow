interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface LlmMessage {
  role: 'system' | 'user';
  content: string;
}

interface LlmCallResult {
  rawText: string;
  model: string;
  error?: string;
}

function readConfig(): LlmConfig {
  const baseUrl =
    process.env.OFFERFLOW_LLM_BASE_URL ||
    process.env.DEEPSEEK_BASE_URL ||
    '';
  const apiKey =
    process.env.OFFERFLOW_LLM_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    '';
  const model =
    process.env.OFFERFLOW_LLM_MODEL ||
    process.env.DEEPSEEK_MODEL ||
    '';

  return { baseUrl, apiKey, model };
}

export function getLlmConfig(): LlmConfig {
  return readConfig();
}

export function getMissingLlmConfigFields(): string[] {
  const config = readConfig();
  const missing: string[] = [];
  if (config.baseUrl === '') {
    missing.push('BASE_URL');
  }
  if (config.apiKey === '') {
    missing.push('API_KEY');
  }
  if (config.model === '') {
    missing.push('MODEL');
  }
  return missing;
}

export function isLlmConfigured(): boolean {
  return getMissingLlmConfigFields().length === 0;
}

function buildConfigErrorMessage(): string {
  const missing = getMissingLlmConfigFields();
  if (missing.length === 0) {
    return '';
  }
  return `LLM 未配置：缺少环境变量 ${missing.join(', ')}。请设置 OFFERFLOW_LLM_${missing.join(' / OFFERFLOW_LLM_')}（或对应的 DEEPSEEK_* 变量）`;
}

export async function chatCompletion(
  systemPrompt: string,
  userMessage: string,
): Promise<LlmCallResult> {
  const config = readConfig();

  if (!isLlmConfigured()) {
    return {
      rawText: '',
      model: config.model || 'unknown',
      error: buildConfigErrorMessage(),
    };
  }

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  try {
    const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        rawText: '',
        model: config.model,
        error: `LLM 调用失败 (HTTP ${response.status}): ${errorText}`,
      };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content ?? '';
    if (content === '') {
      return {
        rawText: '',
        model: config.model,
        error: 'LLM 返回空内容',
      };
    }

    return {
      rawText: content,
      model: config.model,
    };
  } catch (error) {
    return {
      rawText: '',
      model: config.model,
      error: `LLM 调用异常: ${(error as Error).message}`,
    };
  }
}