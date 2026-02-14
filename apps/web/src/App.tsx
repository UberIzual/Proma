import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { AppShell } from './components/app-shell/AppShell'
import { OnboardingView } from './components/onboarding/OnboardingView'
import { TooltipProvider } from './components/ui/tooltip'
import { environmentCheckResultAtom } from './atoms/environment'
import {
  themeModeAtom,
  systemIsDarkAtom,
  resolvedThemeAtom,
  applyThemeToDOM,
  initializeTheme,
} from './atoms/theme'
import type { AppShellContextType } from './contexts/AppShellContext'

/**
 * 主题初始化组件
 *
 * 负责从设置加载主题模式、监听系统主题变化，
 * 并将最终主题同步到 DOM。
 */
function ThemeInitializer(): null {
  const setThemeMode = useSetAtom(themeModeAtom)
  const setSystemIsDark = useSetAtom(systemIsDarkAtom)
  const resolvedTheme = useAtomValue(resolvedThemeAtom)

  // 初始化：加载设置 + 订阅系统主题变化
  React.useEffect(() => {
    let isMounted = true
    let cleanup: (() => void) | undefined

    initializeTheme(setThemeMode, setSystemIsDark)
      .then((fn) => {
        if (isMounted) {
          cleanup = fn
        } else {
          // StrictMode 场景：组件卸载后补偿清理
          fn()
        }
      })
      .catch((error) => {
        console.error('[Theme] 初始化失败:', error)
      })

    return () => {
      isMounted = false
      cleanup?.()
    }
  }, [setThemeMode, setSystemIsDark])

  // 响应式应用主题到 DOM
  React.useEffect(() => {
    applyThemeToDOM(resolvedTheme)
  }, [resolvedTheme])

  return null
}

export default function App(): React.ReactElement {
  const setEnvironmentResult = useSetAtom(environmentCheckResultAtom)
  const [isLoading, setIsLoading] = React.useState(true)
  const [showOnboarding, setShowOnboarding] = React.useState(false)

  // 初始化：检查 onboarding 状态和环境
  React.useEffect(() => {
    const initialize = async () => {
      try {
        // 1. 获取设置，检查是否需要 onboarding
        const settings = await window.electronAPI.getSettings()

        // 2. 执行环境检测（无论是否完成 onboarding）
        const envResult = await window.electronAPI.checkEnvironment()
        setEnvironmentResult(envResult)

        // 3. 判断是否显示 onboarding
        if (!settings.onboardingCompleted) {
          setShowOnboarding(true)
        }
      } catch (error) {
        console.error('[App] 初始化失败:', error)
      } finally {
        setIsLoading(false)
      }
    }

    initialize()
  }, [setEnvironmentResult])

  // 完成 onboarding 回调
  const handleOnboardingComplete = () => {
    setShowOnboarding(false)
  }

  // Placeholder context value
  const contextValue: AppShellContextType = {}

  let content: React.ReactElement
  if (isLoading) {
    content = (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">正在初始化...</p>
        </div>
      </div>
    )
  } else if (showOnboarding) {
    content = (
      <TooltipProvider delayDuration={200}>
        <OnboardingView onComplete={handleOnboardingComplete} />
      </TooltipProvider>
    )
  } else {
    content = (
      <TooltipProvider delayDuration={200}>
        <AppShell contextValue={contextValue} />
      </TooltipProvider>
    )
  }

  return (
    <>
      <ThemeInitializer />
      {content}
    </>
  )
}
