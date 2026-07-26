const { app } = require('electron')
// 重新整理 PATH（安裝後的 CUDA bin 可能只在 Machine PATH）
const { execSync } = require('child_process')
try {
  const machine = execSync(
    'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'Path\',\'Machine\')"',
    { encoding: 'utf8' }
  ).trim()
  const user = execSync(
    'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'Path\',\'User\')"',
    { encoding: 'utf8' }
  ).trim()
  process.env.PATH = [machine, user, process.env.PATH].filter(Boolean).join(';')
} catch { /* ignore */ }

app.whenReady().then(async () => {
  try {
    const cudaEnv = require('../src/main/cuda-env')
    console.log('cudaRuntime', JSON.stringify(cudaEnv.detectCudaRuntime(), null, 2))
    const { getLlama, getLlamaGpuTypes } = await import('node-llama-cpp')
    console.log('gpuTypes', await getLlamaGpuTypes())
    for (const gpu of [false, 'cuda', 'vulkan', 'auto']) {
      try {
        const llama = await getLlama({ gpu, progressLogs: true })
        console.log('OK', gpu, '→', llama.gpu)
        if (typeof llama.dispose === 'function') await llama.dispose()
      } catch (e) {
        console.log('FAIL', gpu, e.name, e.message)
      }
    }
  } catch (e) {
    console.error('fatal', e)
  }
  process.exit(0)
})
