/**
 * QwenProxy - 100+ Requests Real Stress Test & Deep Diagnostic Benchmark
 *
 * Dispatches 100+ diverse prompts against the live QwenProxy server,
 * logging every detail: TTFB, total latency, HTTP status, token throughput,
 * streaming vs non-streaming, account rotation, and error payloads.
 *
 * Usage:
 *   npx tsx scripts/stress-test.ts
 *   npx tsx scripts/stress-test.ts --count=100 --concurrency=2
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

// ─── CLI Options Parsing ───────────────────────────────────────────────────────

function parseArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const TOTAL_REQUESTS = parseInt(parseArg("count", "100"), 10);
const CONCURRENCY = Math.max(1, parseInt(parseArg("concurrency", "2"), 10));
const BASE_URL = parseArg("url", "http://127.0.0.1:7936/v1");
const API_KEY = parseArg("key", process.env.API_KEY || "sk-qwenproxy-local");

// ─── Diverse Prompt Bank (100 Distinct Prompts) ───────────────────────────────

const PROMPT_BANK = [
  // Math & Logic
  "Calcule a raiz quadrada de 144 e explique o raciocínio em uma linha.",
  "Se 5 gatos pegam 5 ratos em 5 minutos, quantos minutos 100 gatos levam para pegar 100 ratos?",
  "Qual é o próximo número da sequência: 2, 3, 5, 8, 13, 21, ?",
  "Converta 255 para binário e hexadecimal com uma breve explicação.",
  "Qual é a probabilidade de tirar duas caras consecutivas em uma moeda justa?",
  "Resolva a equação 2x + 15 = 45 e mostre o valor de x.",
  "Quantos segundos existem em 3 horas e meia?",
  "O que pesa mais: 1kg de chumbo ou 1kg de algodão? Explique com física.",
  "Diga os 5 primeiros números primos maiores que 50.",
  "Explique o Teorema de Pitágoras em duas frases simples.",

  // Programming & Software Engineering
  "Escreva uma função debounce simples em TypeScript.",
  "Explique a diferença entre process.nextTick e setImmediate no Node.js.",
  "Como funciona o padrão Singleton em Go? Dê um exemplo breve.",
  "Qual é a diferença entre interface e type alias no TypeScript?",
  "Escreva uma consulta SQL para encontrar o segundo maior salário de uma tabela.",
  "Explique o que é o Teorema CAP em sistemas distribuídos de forma concisa.",
  "Como evitar ataques de SQL Injection em aplicações modernas?",
  "O que é uma Promise no JavaScript e quais são os seus três estados?",
  "Explique a diferença entre git merge e git rebase em três tópicos.",
  "Como funciona o garbage collector V8 no Node.js em alto nível?",
  "Escreva uma regex para validar endereços de e-mail básicos.",
  "O que é idempotência em APIs RESTful? Dê dois exemplos de métodos HTTP.",
  "Explique o conceito de Race Condition em programação concorrente.",
  "Qual a diferença entre Mutex e Semáforo em sistemas operacionais?",
  "Escreva uma função em Python para inverter uma string sem usar [::-1].",
  "O que significa WAL mode no SQLite e quais são suas vantagens de concorrência?",
  "Explique o princípio Open/Closed do SOLID com um exemplo prático.",
  "Como funciona o algoritmo de busca binária e qual sua complexidade de tempo?",
  "O que é memoization em programação funcional? Dê um exemplo rápido.",
  "Qual é a diferença entre autenticação por sessão e por JWT?",

  // Architecture & DevOps
  "Qual a diferença entre Docker container e máquina virtual tradicional?",
  "Explique como funciona o DNS round-robin e suas limitações.",
  "O que é um proxy reverso e cite dois casos de uso práticos.",
  "Como funciona a multiplexação no protocolo HTTP/2?",
  "Qual a diferença entre polling, WebSockets e Server-Sent Events (SSE)?",
  "O que é Content Delivery Network (CDN) e como ela reduz a latência?",
  "Explique a diferença entre escalabilidade horizontal e vertical.",
  "O que é um circuit breaker em arquitetura de microsserviços?",
  "Para que serve um arquivo docker-compose.yml?",
  "O que é Kubernetes e qual o papel de um Pod?",

  // Tool Call / Reasoning Simulation
  "Liste 3 vantagens do uso de Rust em sistemas críticos de infraestrutura.",
  "Analise a complexidade de tempo e espaço do QuickSort no pior caso.",
  "Explique a diferença entre deadlocks e livelocks com analogias.",
  "Como funciona a criptografia assimétrica RSA em três passos simples?",
  "O que são hash tables e como elas resolvem colisões por encadeamento?",
  "Explique a diferença entre TCP e UDP em termos de confiabilidade e overhead.",
  "O que é zero-copy no Linux e como melhora o throughput de I/O de rede?",
  "Como o protocolo Raft atinge consenso distribuído?",
  "Explique o funcionamento de um connection pool em bancos relacionais.",
  "O que é consistência eventual e onde ela é comumente aplicada?",

  // Creative & Analytical
  "Resuma a história da invenção do transistor em 3 parágrafos curtos.",
  "Quem foi Ada Lovelace e qual sua contribuição histórica para a computação?",
  "Explique o paradoxo de Fermi em poucas palavras.",
  "Qual é a distância média da Terra à Lua em quilômetros?",
  "O que é a Teoria da Relatividade Geral de Einstein em termos simples?",
  "Explique o que é a computação quântica e o conceito de qubit.",
  "Quais são as três leis da robótica de Isaac Asimov?",
  "Explique o que é o efeito Doppler com um exemplo sonoro comum.",
  "Qual é a diferença entre fissão nuclear e fusão nuclear?",
  "Como funciona a fotossíntese nas plantas em duas frases?",

  // Short direct questions
  "Qual é a capital da Austrália?",
  "Quem escreveu Dom Casmurro?",
  "Qual é o elemento químico mais abundante no universo?",
  "Em que ano o homem pisou na Lua pela primeira vez?",
  "Qual é o maior oceano da Terra?",
  "Quantos ossos tem o corpo humano adulto?",
  "Qual é a velocidade da luz no vácuo em km/s?",
  "Qual o idioma mais falado no mundo como língua materna?",
  "Qual é a fórmula química da água e do sal de cozinha?",
  "Quantos continentes existem no modelo geográfico tradicional?",

  // Edge cases & Formatting
  "Gere um JSON válido com três cidades e suas respectivas populações estimadas.",
  "Converta a lista [5, 2, 9, 1, 5, 6] para ordem crescente sem duplicatas.",
  "Explique a expressão idiomática 'dar uma volta por cima'.",
  "Qual a diferença entre precisão e acurácia na ciência de dados?",
  "O que é overfitting em aprendizado de máquina e como preveni-lo?",
  "O que são transformers no contexto de inteligência artificial?",
  "Explique a técnica de Chain of Thought em modelos de linguagem.",
  "Qual a diferença entre parâmetros e hiperparâmetros em machine learning?",
  "O que significa RAG (Retrieval-Augmented Generation) em IA?",
  "Explique o conceito de temperature na amostragem de LLMs.",

  // Rapid Queries
  "Diga 'OK' e um número aleatório entre 1 e 1000.",
  "Responda apenas com a palavra: CONFIRMADO.",
  "Qual é o dia do programador no calendário?",
  "O que significa a sigla API?",
  "O que significa a sigla JSON?",
  "O que é UTF-8 e por que ele é o padrão na web?",
  "O que significa ACID em bancos de dados relacionais?",
  "O que é CORS e por que os navegadores o bloqueiam por padrão?",
  "Qual a diferença entre null e undefined no JavaScript?",
  "O que é uma closure no JavaScript?",

  // Final stretch
  "Explique o conceito de microtarefas vs macrotarefas no Event Loop.",
  "O que é um proxy HTTP CONNECT e como difere de um proxy transparente?",
  "Qual é a função do cabeçalho User-Agent na web?",
  "Como funciona o protocolo TLS handshake simplificado?",
  "O que é SHA-256 e para que ele é usado?",
  "Qual é a diferença entre CPU bound e I/O bound?",
  "O que são soft skills e por que são vitais na engenharia de software?",
  "Como funciona o sistema de versionamento semântico (SemVer)?",
  "O que é um commit atômico no Git e por que é uma boa prática?",
  "Finalize este teste com uma frase motivacional curta sobre programação.",
];

const MODELS = ["qwen3.8-max", "qwen3.7-plus", "qwen3.8-omni-flash"];

// ─── Data Types ───────────────────────────────────────────────────────────────

interface RequestRecord {
  index: number;
  reqId: string | null;
  model: string;
  stream: boolean;
  prompt: string;
  status: number;
  ok: boolean;
  ttfbMs: number;
  totalMs: number;
  outputChars: number;
  tokensPerSec: number;
  contentPreview: string;
  timingHeader: string | null;
  error: string | null;
  timestamp: string;
}

// ─── Worker Execution ─────────────────────────────────────────────────────────

async function executeSingleRequest(
  index: number,
  prompt: string,
  model: string,
  stream: boolean,
): Promise<RequestRecord> {
  const startedAt = performance.now();
  let ttfbMs = 0;
  let outputText = "";
  let reqId: string | null = null;
  let timingHeader: string | null = null;
  let statusCode = 0;
  let errorMsg: string | null = null;

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream,
        max_tokens: 300,
      }),
    });

    statusCode = response.status;
    reqId = response.headers.get("x-request-id");
    timingHeader = response.headers.get("x-qwenproxy-timing");

    if (stream) {
      if (!response.body) throw new Error("No response body received");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (ttfbMs === 0) {
          ttfbMs = Math.round(performance.now() - startedAt);
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.replace(/^data:\s*/, "").trim();
          if (dataStr === "[DONE]") break;

          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              outputText += delta.content;
            }
          } catch {}
        }
      }
    } else {
      ttfbMs = Math.round(performance.now() - startedAt);
      const json: any = await response.json().catch(() => null);
      if (response.ok && json?.choices?.[0]?.message?.content) {
        outputText = json.choices[0].message.content;
      } else {
        errorMsg = JSON.stringify(json || {});
      }
    }

    if (!response.ok && !errorMsg) {
      errorMsg = `HTTP ${response.status} ${response.statusText}`;
    }
  } catch (err: any) {
    errorMsg = err.message || String(err);
  }

  const totalMs = Math.round(performance.now() - startedAt);
  if (ttfbMs === 0) ttfbMs = totalMs;

  const estimatedTokens = Math.max(1, Math.round(outputText.length / 4));
  const tokensPerSec = totalMs > 0 ? Math.round((estimatedTokens / (totalMs / 1000)) * 10) / 10 : 0;
  const ok = statusCode >= 200 && statusCode < 300 && errorMsg === null;

  return {
    index,
    reqId,
    model,
    stream,
    prompt: prompt.slice(0, 100),
    status: statusCode,
    ok,
    ttfbMs,
    totalMs,
    outputChars: outputText.length,
    tokensPerSec,
    contentPreview: outputText.slice(0, 120).replace(/\s+/g, " "),
    timingHeader,
    error: errorMsg,
    timestamp: new Date().toISOString(),
  };
}

// ─── Main Stress Runner ───────────────────────────────────────────────────────

async function main() {
  console.log("==================================================================");
  console.log(`🚀 QwenProxy Real Stress Test — ${TOTAL_REQUESTS} Requests (Concurrency: ${CONCURRENCY})`);
  console.log(`📡 Target URL: ${BASE_URL}/chat/completions`);
  console.log("==================================================================\n");

  // Verify server is alive before bombarding
  try {
    const health = await fetch("http://127.0.0.1:7936/health", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (!health.ok) {
      console.error(`❌ Servidor em 127.0.0.1:7936 retornou status ${health.status}. Inicie o proxy com 'npm start' antes.`);
      process.exit(1);
    }
    console.log("✅ Servidor QwenProxy detectado e respondendo em :7936! Iniciando disparos...\n");
  } catch (err: any) {
    console.error("❌ Não foi possível conectar ao QwenProxy em http://127.0.0.1:7936/health.");
    console.error("   Certifique-se de iniciar o servidor em outro terminal: npm run start");
    process.exit(1);
  }

  const results: RequestRecord[] = [];
  const logDir = path.resolve("data/logs");
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const liveLogFile = path.join(logDir, "stress-test-100-live.log");
  fs.writeFileSync(liveLogFile, `=== QWENPROXY 100-REQUEST STRESS TEST STARTED AT ${new Date().toISOString()} ===\n\n`, "utf8");

  const startTime = performance.now();
  let completedCount = 0;
  let successCount = 0;
  let failureCount = 0;

  // Queue of tasks
  const tasks = Array.from({ length: TOTAL_REQUESTS }, (_, i) => {
    const prompt = PROMPT_BANK[i % PROMPT_BANK.length];
    const model = MODELS[i % MODELS.length];
    const stream = i % 5 !== 0; // 80% stream, 20% non-stream
    return { index: i + 1, prompt, model, stream };
  });

  // Concurrency pool runner
  async function runWorker(workerId: number) {
    while (tasks.length > 0) {
      const task = tasks.shift();
      if (!task) break;

      const record = await executeSingleRequest(task.index, task.prompt, task.model, task.stream);
      results.push(record);
      completedCount++;

      if (record.ok) successCount++;
      else failureCount++;

      const statusTag = record.ok ? "✅ 200 OK" : `❌ ${record.status || "ERR"}`;
      const logLine = `[${String(record.index).padStart(3, "0")}/${TOTAL_REQUESTS}] ${statusTag} | ${record.model} | TTFB: ${record.ttfbMs}ms | Total: ${record.totalMs}ms | ${record.outputChars} chars | ${record.tokensPerSec} t/s | req=${record.reqId || "none"}`;

      console.log(logLine);
      fs.appendFileSync(liveLogFile, `${logLine}\n  Prompt: "${record.prompt}"\n  Preview: "${record.contentPreview}"\n  Error: ${record.error || "none"}\n\n`, "utf8");
    }
  }

  // Launch workers
  const workers = Array.from({ length: CONCURRENCY }, (_, i) => runWorker(i + 1));
  await Promise.all(workers);

  const totalBenchmarkMs = Math.round(performance.now() - startTime);

  // ─── Statistical Computations ───────────────────────────────────────────────

  const totalTimes = results.map((r) => r.totalMs).sort((a, b) => a - b);
  const ttfbTimes = results.map((r) => r.ttfbMs).sort((a, b) => a - b);

  const min = (arr: number[]) => (arr.length ? arr[0] : 0);
  const max = (arr: number[]) => (arr.length ? arr[arr.length - 1] : 0);
  const avg = (arr: number[]) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
  const p = (arr: number[], pct: number) => (arr.length ? arr[Math.floor((arr.length - 1) * pct)] : 0);

  const totalChars = results.reduce((acc, r) => acc + r.outputChars, 0);
  const totalTokensEstimated = Math.round(totalChars / 4);
  const avgThroughput = totalBenchmarkMs > 0 ? Math.round((totalTokensEstimated / (totalBenchmarkMs / 1000)) * 10) / 10 : 0;

  const summary = `
==================================================================
 📊 QwenProxy Stress Test Results — Final Deep Report
==================================================================

⏱️  Tempo Total do Teste: ${(totalBenchmarkMs / 1000).toFixed(2)}s
📦 Total de Requisições: ${TOTAL_REQUESTS}
✅ Sucessos: ${successCount} (${((successCount / TOTAL_REQUESTS) * 100).toFixed(1)}%)
❌ Falhas: ${failureCount} (${((failureCount / TOTAL_REQUESTS) * 100).toFixed(1)}%)
⚡ Vazão Média: ${avgThroughput} tokens/segundo
📝 Total de Caracteres Gerados: ${totalChars.toLocaleString()} (~${totalTokensEstimated.toLocaleString()} tokens)

--- Latência Total (End-to-End) ---
  Min:  ${min(totalTimes)}ms
  P50:  ${p(totalTimes, 0.5)}ms
  Avg:  ${avg(totalTimes)}ms
  P90:  ${p(totalTimes, 0.9)}ms
  P95:  ${p(totalTimes, 0.95)}ms
  P99:  ${p(totalTimes, 0.99)}ms
  Max:  ${max(totalTimes)}ms

--- Time to First Byte (TTFB / Início do Stream) ---
  Min:  ${min(ttfbTimes)}ms
  P50:  ${p(ttfbTimes, 0.5)}ms
  Avg:  ${avg(ttfbTimes)}ms
  P90:  ${p(ttfbTimes, 0.9)}ms
  P95:  ${p(ttfbTimes, 0.95)}ms
  Max:  ${max(ttfbTimes)}ms

--- Distribuição por Modelo ---
${MODELS.map((m) => {
  const modelReqs = results.filter((r) => r.model === m);
  const modelOk = modelReqs.filter((r) => r.ok).length;
  const modelAvg = avg(modelReqs.map((r) => r.totalMs));
  return `  • ${m.padEnd(20)}: ${modelReqs.length} reqs | ${modelOk} ok | Latência média: ${modelAvg}ms`;
}).join("\n")}

==================================================================
`;

  console.log(summary);

  // Write full reports to disk
  const jsonReportPath = path.join(logDir, "stress-test-100-results.json");
  const summaryReportPath = path.join(logDir, "stress-test-100-summary.txt");

  fs.writeFileSync(jsonReportPath, JSON.stringify(results, null, 2), "utf8");
  fs.writeFileSync(summaryReportPath, summary, "utf8");

  console.log(`📁 Relatório JSON detalhado salvo em: ${jsonReportPath}`);
  console.log(`📄 Resumo executivo salvo em: ${summaryReportPath}`);
  console.log(`📜 Log contínuo salvo em: ${liveLogFile}\n`);
}

main().catch(console.error);
