import BallWindow from './windows/BallWindow'
import MenuWindow from './windows/MenuWindow'
import StickyWindow from './windows/StickyWindow'
import BubbleWindow from './windows/BubbleWindow'
import LibraryPage from './pages/LibraryPage'
import SettingsPage from './pages/SettingsPage'
import PlaceholderPage from './pages/PlaceholderPage'

/** 按窗口 hash 分发渲染（#/window/<kind>） */
export default function App() {
  const kind = window.api.windowKind()
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '')

  switch (kind) {
    case 'ball':
      return <BallWindow />
    case 'menu':
      return <MenuWindow />
    case 'bubble':
      return <BubbleWindow />
    case 'sticky': {
      const editId = Number(params.get('id') ?? '') || null
      return <StickyWindow editId={editId} />
    }
    case 'page': {
      const pageKind = params.get('kind') ?? 'library'
      if (pageKind === 'library') return <LibraryPage />
      if (pageKind === 'settings') return <SettingsPage />
      return <PlaceholderPage kind={pageKind} />
    }
    default:
      return <BallWindow />
  }
}
