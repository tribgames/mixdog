import {
  embedText,
  embedTexts,
  getEmbeddingDtype,
  getEmbeddingModelId,
  shutdownEmbeddingProvider,
  warmupEmbeddingProvider,
} from '../src/runtime/memory/lib/embedding-provider.mjs'

const cases = [
  {
    query: '윈도우 음성 인식이 너무 많은 메모리를 쓰는 원인은?',
    relevant: 'Windows 음성 인식 런타임은 CUDA DLL과 Whisper 모델을 함께 올려 메모리 사용량이 커졌다.',
    distractors: [
      'macOS 렌더러는 창 크기를 local storage에 저장한다.',
      '세션 목록은 최근 접속 시각을 기준으로 정렬한다.',
    ],
  },
  {
    query: 'How is the embedding worker released when it becomes idle?',
    relevant: 'The embedding worker terminates after its idle timeout so native ONNX memory returns to the OS.',
    distractors: [
      'The release workflow uploads desktop installers to GitHub.',
      'The renderer uses CSS grid to arrange conversation panes.',
    ],
  },
  {
    query: '검색 query와 저장 문서의 embedding 입력은 어떻게 구분해?',
    relevant: '검색 query에는 retrieval instruction을 붙이고 저장 문서는 원문 그대로 embedding한다.',
    distractors: [
      '음성 녹음은 WAV 파일로 임시 저장한 뒤 삭제한다.',
      '데스크톱 업데이트는 설치된 앱의 userData를 보존한다.',
    ],
  },
  {
    query: 'Which function opens the memory database with the active embedding identity?',
    relevant: 'openDatabase receives the embedding identity and resets incompatible stored vectors.',
    distractors: [
      'ensureReady starts the whisper server on an available TCP port.',
      'selectVoiceModelId chooses the bundled speech recognition model.',
    ],
  },
]

function cosine(a, b) {
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return dot / Math.sqrt(aa * bb)
}

const startedAt = performance.now()
try {
  await warmupEmbeddingProvider()
  let hits = 0
  const margins = []
  const rows = []

  for (const item of cases) {
    const documents = [item.relevant, ...item.distractors]
    const [queryVector, documentVectors] = await Promise.all([
      embedText(item.query, { inputType: 'query', priority: true }),
      embedTexts(documents, { inputType: 'document' }),
    ])
    const scores = documentVectors.map((vector, index) => ({
      index,
      score: cosine(queryVector, vector),
    })).sort((a, b) => b.score - a.score)
    const hit = scores[0].index === 0
    if (hit) hits++
    margins.push(scores.find((row) => row.index === 0).score - scores.find((row) => row.index !== 0).score)
    rows.push({
      query: item.query,
      hit,
      relevant: Number(scores.find((row) => row.index === 0).score.toFixed(4)),
      bestDistractor: Number(scores.find((row) => row.index !== 0).score.toFixed(4)),
    })
  }

  console.log(JSON.stringify({
    model: getEmbeddingModelId(),
    dtype: getEmbeddingDtype(),
    hitAt1: `${hits}/${cases.length}`,
    meanMargin: Number((margins.reduce((sum, value) => sum + value, 0) / margins.length).toFixed(4)),
    wallMs: Math.round(performance.now() - startedAt),
    rssMiB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
    rows,
  }, null, 2))
} finally {
  await shutdownEmbeddingProvider()
}
