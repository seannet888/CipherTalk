import type {
  ConversationRequest,
  ProgressEvent,
  ProgressEmit,
  ScopedSession,
  RunConversationResult,
  StreamEvent,
  StreamEmit
} from './types'
import { aiService } from '../ai/aiService'
import { resolveScope } from './scope'
import { runGlobalConversation } from './global/globalAgent'

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Aborted')
  }
}

function emitStream(emit: StreamEmit, event: unknown): void {
  emit(event as StreamEvent)
}

function emitProgress(onProgress: ProgressEmit, event: unknown): void {
  onProgress(event as ProgressEvent)
}

function getSingleScopedSession(request: ConversationRequest): ScopedSession | null {
  const sessions = new Map<string, ScopedSession>()
  for (const session of request.scopedSessions || []) {
    const id = String(session.id || '').trim()
    if (!id) continue
    sessions.set(id, { id, name: session.name || id })
  }
  return sessions.size === 1 ? [...sessions.values()][0] : null
}

function buildScopedQuestion(request: ConversationRequest): string {
  const hint = request.commandHint?.trim()
  return hint ? `${request.message}\n\n用户意图补充：${hint}` : request.message
}

export async function run(
  request: ConversationRequest,
  emit: StreamEmit,
  onProgress: ProgressEmit,
  signal: AbortSignal
): Promise<RunConversationResult> {
  const scope = resolveScope(request.scope)
  assertNotAborted(signal)

  if (scope.kind === 'session') {
    const result = await aiService.answerSessionQuestion(
      {
        conversationId: request.conversationId,
        sessionId: scope.sessionId,
        sessionName: scope.sessionName,
        question: request.message,
        history: request.history,
        provider: request.provider.provider,
        apiKey: request.provider.apiKey,
        model: request.provider.model,
        enableThinking: request.forceThinking ?? request.provider.enableThinking,
        signal,
      },
      event => emitStream(emit, event),
      event => emitProgress(onProgress, event)
    )

    return {
      conversationId: request.conversationId ?? 0,
      answerText: result.answerText
    }
  }

  const scopedSession = getSingleScopedSession(request)
  if (scopedSession) {
    emitProgress(onProgress, {
      id: 'global-scope-resolved',
      stage: 'intent',
      status: 'completed',
      title: '识别会话范围',
      detail: `已定位到单个会话：${scopedSession.name}，切换到会话编排`,
      requestId: request.requestId,
      createdAt: Date.now(),
      source: 'chat'
    })

    const result = await aiService.answerSessionQuestion(
      {
        conversationId: request.conversationId,
        sessionId: scopedSession.id,
        sessionName: scopedSession.name,
        question: buildScopedQuestion(request),
        history: request.history,
        provider: request.provider.provider,
        apiKey: request.provider.apiKey,
        model: request.provider.model,
        enableThinking: request.forceThinking ?? request.provider.enableThinking,
        signal,
      },
      event => emitStream(emit, event),
      event => emitProgress(onProgress, event)
    )

    return {
      conversationId: request.conversationId ?? 0,
      answerText: result.answerText
    }
  }

  const answerText = await runGlobalConversation(request, emit, signal)
  return {
    conversationId: request.conversationId ?? 0,
    answerText
  }
}
