import { readFileSync, writeFileSync } from 'fs';

const filePath = 'C:/Users/Administrator/lingxi-engine/index.ts';
const content = readFileSync(filePath, 'utf-8');
const lines = content.split('\n');

console.log('Total lines:', lines.length);

// Find the multi-ai route
let startIdx = -1;
let endIdx = -1;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("app.post('/api/multi-ai'") || lines[i].includes('app.post(\'/api/multi-ai\'')) {
    startIdx = i;
    break;
  }
}

if (startIdx === -1) {
  console.error('Could not find start of multi-ai route');
  process.exit(1);
}

console.log('Found start at line:', startIdx + 1);

// Find the end - look for the next app.post('/api/providers'
for (let i = startIdx + 1; i < lines.length; i++) {
  if (lines[i].includes("app.post('/api/providers'") || lines[i].includes('app.post(\'/api/providers\'')) {
    endIdx = i - 1;
    break;
  }
}

if (endIdx === -1) {
  console.error('Could not find end of multi-ai route');
  process.exit(1);
}

console.log('Found end at line:', endIdx + 1);
console.log('Route spans lines:', startIdx + 1, 'to', endIdx + 1);

// New route content - use any[] for messages to avoid OpenAI SDK type issues
const newRoute = `  app.post('/api/multi-ai', requireAuth, async (req, res) => {
    try {
      const { mode, models, message, history } = req.body || {};
      if (!message || !Array.isArray(models) || models.length === 0) {
        return res.status(400).json({ error: 'message 和 models 必填' });
      }
      if (models.length > 6) { return res.status(400).json({ error: '最多选择6个模型' }); }
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      const send = (event: string, data: unknown) => { res.write(\`event: \${event}\\n\`); res.write(\`data: \${JSON.stringify(data)}\\n\\n\`); };

      // Build messages with token-aware truncation per model
      const MAX_HISTORY_TOKENS = 8000; // conservative default, models have 8k-32k windows
      const buildMessages = (modelId: string, sys: string, extra: Array<{role?: string; content: string; name?: string; tool_call_id?: string}> = []) => {
        const msgs: any[] = [{ role: 'system', content: sys }];
        let tokenEstimate = 0;
        const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
        tokenEstimate += estimateTokens(sys);
        
        const hist = (history || []).slice().reverse();
        const kept: Array<{role?: string; content: string; name?: string; tool_call_id?: string}> = [];
        for (const h of hist) {
          const t = estimateTokens(h.content || '');
          if (tokenEstimate + t > MAX_HISTORY_TOKENS) break;
          kept.unshift({ role: h.role || 'user', content: h.content, name: h.name, tool_call_id: h.tool_call_id });
          tokenEstimate += t;
        }
        for (const m of kept) msgs.push({ role: m.role || 'user', content: m.content, name: m.name, tool_call_id: m.tool_call_id });
        
        for (const h of extra) {
          const t = estimateTokens(h.content || '');
          if (tokenEstimate + t > MAX_HISTORY_TOKENS) break;
          msgs.push({ role: h.role || 'user', content: h.content, name: h.name, tool_call_id: h.tool_call_id });
          tokenEstimate += t;
        }
        
        msgs.push({ role: 'user', content: message });
        return msgs;
      };

      const callModel = async (modelId: string, sys: string, extra: Array<{role?: string; content: string; name?: string; tool_call_id?: string}> = []): Promise<string> => {
        const cr = aiHub.getClient(modelId);
        if (!cr) {
          if (process.env.LINGXI_STRICT_MODEL === 'true') {
            throw new Error(\`严格模式下找不到模型: \${modelId} (已禁用静默降级)\`);
          }
          console.warn('[MultiAI] 模型未命中，尝试默认模型:', modelId, '->', aiHub.getDefaultModel());
          const fallback = aiHub.getClient(aiHub.getDefaultModel());
          if (!fallback) throw new Error('找不到模型且无默认模型可用: ' + modelId);
          return callModel(aiHub.getDefaultModel(), sys, extra);
        }
        
        const msgs = buildMessages(modelId, sys, extra);
        let full = '';
        
        const tools = toolRegistry 
          ? toolRegistry.listToolsForSkills(['general-assistant']).map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: { type: 'object', properties: t.parameters?.properties || {}, required: t.parameters?.required || [] } }
            }))
          : undefined;
        
        try {
          const stream = await cr.client.chat.completions.create({ 
            model: cr.resolvedModel, 
            messages: msgs as any, 
            stream: true, 
            temperature: 0.7, 
            tools: tools as any 
          });
          
          for await (const chunk of stream) {
            const d = chunk.choices?.[0]?.delta?.content;
            if (d) { full += d; send('chunk', { model: modelId, text: d }); }
            
            const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
            if (toolCalls && toolRegistry) {
              for (const tc of toolCalls) {
                if (tc.function?.name && tc.function?.arguments) {
                  try {
                    const args = JSON.parse(tc.function.arguments || '{}');
                    const result = await toolRegistry.execute({ id: tc.id || 'multi-ai-tool', name: tc.function.name, arguments: args });
                    send('tool', { model: modelId, tool: tc.function.name, result: JSON.stringify(result).slice(0, 200) });
                    msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
                    msgs.push({ role: 'tool', tool_call_id: tc.id || 'multi-ai-tool', content: JSON.stringify(result).slice(0, 4000) });
                  } catch(e: unknown) { send('tool', { model: modelId, tool: tc.function.name, error: (e as Error).message }); }
                }
              }
            }
          }
        } catch (e: unknown) {
          const resp = await cr.client.chat.completions.create({ model: cr.resolvedModel, messages: msgs as any, temperature: 0.7, tools: tools as any });
          full = resp.choices?.[0]?.message?.content || '';
          
          const respToolCalls = resp.choices?.[0]?.message?.tool_calls;
          if (respToolCalls && toolRegistry) {
            for (const tc of respToolCalls) {
              try {
                const args = JSON.parse(tc.function.arguments || '{}');
                const result = await toolRegistry.execute({ id: tc.id || 'multi-ai-tool', name: tc.function.name, arguments: args });
                send('tool', { model: modelId, tool: tc.function.name, result: JSON.stringify(result).slice(0, 200) });
                msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
                msgs.push({ role: 'tool', tool_call_id: tc.id || 'multi-ai-tool', content: JSON.stringify(result).slice(0, 4000) });
              } catch(e2: unknown) { send('tool', { model: modelId, tool: tc.function.name, error: (e2 as Error).message }); }
            }
            if (respToolCalls.length > 0) {
              const resp2 = await cr.client.chat.completions.create({ model: cr.resolvedModel, messages: msgs as any, temperature: 0.7 });
              full = resp2.choices?.[0]?.message?.content || full;
              send('chunk', { model: modelId, text: full });
            }
          }
          if (!full) { full = resp.choices?.[0]?.message?.content || ''; send('chunk', { model: modelId, text: full }); }
        }
        
        send('done', { model: modelId, full });
        return full;
      };
      
      const mt = mode || 'free';
      
      if (mt === 'free' || mt === 'brainstorm') {
        const p = mt === 'brainstorm' ? '你是一个创意顾问。请针对用户的问题提出你的独特想法和建议，要具体、有创意。' : '你是一个有用的AI助手。请回答用户的问题。';
        await Promise.all(models.map(async (m: string) => {
          try {
            await callModel(m, p);
          } catch (e: unknown) {
            send('error', { model: m, error: (e as Error).message });
          }
        }));
      } else if (mt === 'debate') {
        const replies: string[] = [];
        for (let i = 0; i < models.length; i++) {
          const pos = i === 0 ? '正方（支持）' : i === 1 ? '反方（反对）' : \`第\${i+1}方观点\`;
          const dh = replies.map((r, j) => ({ role: 'assistant' as const, content: \`[\${models[j]} 的发言]: \${r}\` }));
          send('start', { model: models[i], position: pos });
          try {
            replies.push(await callModel(models[i], \`你正在参加一场辩论。你的立场是\${pos}。请针对用户的议题发表你的观点和论据\${dh.length > 0 ? '以下是其他参与者的发言，请回应他们的观点：' : ''}\`, dh));
          } catch (e: unknown) {
            send('error', { model: models[i], error: (e as Error).message });
            replies.push('');
          }
        }
      } else if (mt === 'roundtable') {
        const replies: string[] = [];
        for (let i = 0; i < models.length; i++) {
          const rh = replies.map((r, j) => ({ role: 'assistant' as const, content: \`[\${models[j]} 的发言]: \${r}\` }));
          send('start', { model: models[i], round: i + 1 });
          try {
            replies.push(await callModel(models[i], \`你正在参加一个圆桌讨论。请就用户提出的话题分享你的专业见解\${rh.length > 0 ? '请参考其他参与者的发言并补充你的观点：' : ''}\`, rh));
          } catch (e: unknown) {
            send('error', { model: models[i], error: (e as Error).message });
            replies.push('');
          }
        }
      } else if (mt === 'chain') {
        let acc = '';
        for (let i = 0; i < models.length; i++) {
          const ch = i > 0 ? [{ role: 'assistant' as const, content: \`[上一个模型(\${models[i-1]})的分析]: \${acc}\` }] : [];
          send('start', { model: models[i], step: i + 1 });
          try {
            acc = await callModel(models[i], i === 0 ? '你是一个分析专家。请分析用户的问题并给出你的初步判断。' : '你是一个续写专家。上一个模型已经给出了分析，请在此基础上深入分析并给出你的结论。', ch);
          } catch (e: unknown) {
            send('error', { model: models[i], error: (e as Error).message });
            acc = '';
          }
        }
      } else if (mt === 'vote') {
        const props: Array<{model: string; content: string}> = [];
        for (let i = 0; i < models.length; i++) {
          send('start', { model: models[i], phase: 'proposal' });
          try {
            props.push({ model: models[i], content: await callModel(models[i], '你是一个决策顾问。请针对用户的问题给出你的方案和建议。') });
          } catch (e: unknown) {
            send('error', { model: models[i], error: (e as Error).message });
            props.push({ model: models[i], content: '' });
          }
        }
        for (let i = 0; i < models.length; i++) {
          const pt = props.map(p => \`[\${p.model}的方案]: \${p.content.slice(0, 500)}...\`).join('\\n\\n');
          send('start', { model: models[i], phase: 'vote' });
          try {
            await callModel(models[i], \`你是一个评委。以下是多个方案，请评价并投票选出最佳方案，说明理由。\\n\\n\${pt}\`);
          } catch (e: unknown) {
            send('error', { model: models[i], error: (e as Error).message });
          }
        }
      } else { return res.status(400).json({ error: '不支持的模式: ' + mt }); }
      send('complete', { mode: mt, models });
      res.end();
    } catch (err: unknown) {
      console.error('[MultiAI] error:', err);
      if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
      else { res.write(\`event: error\\ndata: \${JSON.stringify({ error: (err as Error).message })}\\n\\n\`); res.end(); }
    }
  });`;

// Replace
const before = lines.slice(0, startIdx);
const after = lines.slice(endIdx + 1);
const newLines = [...before, ...newRoute.split('\n'), ...after];

writeFileSync(filePath, newLines.join('\n'), 'utf-8');
console.log('Replacement done. New line count:', newLines.length);