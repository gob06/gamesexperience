import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import QRCode from 'qrcode'
import {
  ArrowUpRight,
  Camera,
  Check,
  ChevronRight,
  CircleHelp,
  Copy,
  Download,
  Film,
  Gamepad2,
  ImagePlus,
  LogIn,
  LogOut,
  Maximize,
  MonitorPlay,
  Palette,
  Pencil,
  Plus,
  QrCode,
  Shield,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import ThemeSettings from './ThemeSettings'
import { AdVideoOverlay, AdVideoSettings } from './AdVideo'
import QaAudience from './QaAudience'
import QaMonitor from './QaMonitor'
import QaEditDialog from './QaEditDialog'
import PollEditDialog from './PollEditDialog'
import { SavedLogoPicker, logoToFile, saveLogo, type SavedLogo } from './logoLibrary'
import SelfieCam, { SelfieParticipant } from './SelfieCam'
import { ThemeBrand } from './theme'
import VanishingGame from './VanishingGame'

type PollOption = { id: string; label: string; votes: number; imageUrl?: string | null }
type Poll = { id: string; question: string; joinTitle?: string | null; questionImageUrl?: string | null; options: PollOption[]; createdAt: string; logoUrl?: string | null; isQa: boolean; winnerName?: string; winnerTicketNumber?: string; winnerAnswer?: string; votingEnabled: boolean; videoEnabled: boolean; revealCorrect?: boolean; correctOptionId?: string | null; stats?: { participants: number; submissions: number; winners: number; nonWinners: number } }
type AuthUser = { id: string; username: string; role: 'admin' | 'host' }
type OptionDraft = { label: string; imageFile: File | null; previewUrl: string }
type GameRoomSummary = {
  id: string
  roomName: string
  status: 'waiting' | 'playing'
  playerXName: string
  playerOName: string | null
  updatedAt: string
}

function emptyOptionDrafts(): OptionDraft[] {
  return [
    { label: '', imageFile: null, previewUrl: '' },
    { label: '', imageFile: null, previewUrl: '' },
  ]
}

const pollPath = window.location.pathname.match(/^\/poll\/([^/]+)\/?$/)
const resultsPath = window.location.pathname.match(/^\/poll\/([^/]+)\/display\/?$/)
const monitorPath = window.location.pathname.match(/^\/poll\/([^/]+)\/monitor\/?$/)
const gamePath = window.location.pathname.match(/^\/game(?:\/([^/]+))?\/?$/)
const selfiePath = /^\/selfie\/?$/.test(window.location.pathname)
const selfieJoinPath = window.location.pathname.match(/^\/selfie\/join\/([A-Za-z0-9_-]+)\/?$/)

async function requestPolls(): Promise<Poll[]> {
  const response = await fetch('/api/polls')
  if (!response.ok) throw new Error('Could not load polls.')
  return response.json()
}

async function drawQr(canvas: HTMLCanvasElement, value: string, logoUrl: string | null | undefined, size: number, isActive: () => boolean = () => true) {
  await QRCode.toCanvas(canvas, value, {
    width: size,
    margin: 2,
    errorCorrectionLevel: 'H',
    color: { dark: '#15151a', light: '#ffffff' },
  })
  if (!logoUrl || !isActive()) return
  const logo = new Image()
  await new Promise<void>((resolve) => {
    logo.onload = () => resolve()
    logo.onerror = () => resolve()
    logo.src = logoUrl
  })
  const context = canvas.getContext('2d')
  if (!context || !logo.naturalWidth || !isActive()) return
  const boxSize = Math.round(size * 0.22)
  const padding = Math.round(size * 0.025)
  const innerSize = boxSize - padding * 2
  const scale = Math.min(innerSize / logo.naturalWidth, innerSize / logo.naturalHeight)
  const width = logo.naturalWidth * scale
  const height = logo.naturalHeight * scale
  const left = (size - boxSize) / 2
  const top = (size - boxSize) / 2
  context.fillStyle = '#ffffff'
  context.fillRect(left, top, boxSize, boxSize)
  context.drawImage(logo, (size - width) / 2, (size - height) / 2, width, height)
}

async function downloadQrPng(value: string, logoUrl: string | null | undefined, fileName: string) {
  const canvas = document.createElement('canvas')
  await drawQr(canvas, value, logoUrl, 1024)
  const link = document.createElement('a')
  link.href = canvas.toDataURL('image/png')
  link.download = fileName
  link.click()
}

function PollQrCode({ value, logoUrl, size, label }: { value: string; logoUrl?: string | null; size: number; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !value) return
    let active = true
    void drawQr(canvas, value, logoUrl, size, () => active)
    return () => { active = false }
  }, [value, logoUrl, size])

  return <canvas ref={canvasRef} aria-label={label} />
}

async function getPollShareUrl(pollId: string) {
  const path = `/poll/${encodeURIComponent(pollId)}`
  const fallbackUrl = new URL(path, window.location.origin).href
  if (!['localhost', '127.0.0.1'].includes(window.location.hostname)) return fallbackUrl

  try {
    const response = await fetch('/api/network-addresses')
    if (!response.ok) return fallbackUrl
    const result: { addresses: string[] } = await response.json()
    if (!result.addresses.length) return fallbackUrl

    const phoneUrl = new URL(window.location.origin)
    phoneUrl.hostname = result.addresses[0]
    phoneUrl.pathname = path
    phoneUrl.search = ''
    phoneUrl.hash = ''
    return phoneUrl.href
  } catch {
    return fallbackUrl
  }
}

async function getGameShareUrl(roomId: string) {
  const path = `/game/${encodeURIComponent(roomId)}`
  const fallbackUrl = new URL(path, window.location.origin).href
  if (!['localhost', '127.0.0.1'].includes(window.location.hostname)) return fallbackUrl
  const response = await fetch('/api/network-addresses')
  if (!response.ok) throw new Error('Could not prepare a phone-friendly game link.')
  const result: { addresses: string[] } = await response.json()
  if (!result.addresses.length) return fallbackUrl
  const phoneUrl = new URL(window.location.origin)
  phoneUrl.hostname = result.addresses[0]
  phoneUrl.pathname = path
  phoneUrl.search = ''
  phoneUrl.hash = ''
  return phoneUrl.href
}

function App() {
  const isQaMode = new URLSearchParams(window.location.search).get('mode') === 'qa'
  const [polls, setPolls] = useState<Poll[]>([])
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<OptionDraft[]>(emptyOptionDrafts)
  const [correctOptionIndex, setCorrectOptionIndex] = useState<number | null>(null)
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreviewUrl, setLogoPreviewUrl] = useState('')
  const [questionType, setQuestionType] = useState<'text' | 'image'>('text')
  const [questionImageFile, setQuestionImageFile] = useState<File | null>(null)
  const [questionImagePreviewUrl, setQuestionImagePreviewUrl] = useState('')
  const [revealCorrect, setRevealCorrect] = useState(false)
  const [editPoll, setEditPoll] = useState<Poll | null>(null)
  const questionImageInputRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sharePoll, setSharePoll] = useState<Poll | null>(null)
  const [copied, setCopied] = useState(false)
  const [authLoading, setAuthLoading] = useState(true)
  const [setupRequired, setSetupRequired] = useState(false)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [authError, setAuthError] = useState('')
  const logoInputRef = useRef<HTMLInputElement>(null)
  const optionImageInputRefs = useRef<Array<HTMLInputElement | null>>([])

  const visiblePolls = isQaMode ? polls.filter((poll) => poll.isQa) : polls.filter((poll) => !poll.isQa)

  async function refreshPolls() {
    try {
      setPolls(await requestPolls())
      setError('')
    } catch {
      setError('The poll service is unavailable. Start the app with npm run dev.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    fetch('/api/auth/status')
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not check sign-in status.')
        return response.json()
      })
      .then((result: { setupRequired: boolean; user: AuthUser | null }) => {
        if (!active) return
        setSetupRequired(result.setupRequired)
        setAuthUser(result.user)
        setAuthLoading(false)
      })
      .catch((caught: unknown) => {
        if (!active) return
        setAuthError(caught instanceof Error ? caught.message : 'Could not connect to the sign-in service.')
        setAuthLoading(false)
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!authUser || window.location.pathname !== '/voting') return
    void refreshPolls()
    const timer = window.setInterval(() => void refreshPolls(), 5000)
    return () => window.clearInterval(timer)
  }, [authUser])

  useEffect(() => {
    if (!logoPreviewUrl) return
    return () => URL.revokeObjectURL(logoPreviewUrl)
  }, [logoPreviewUrl])

  function selectPollLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    acceptLogo(file)
  }

  function acceptLogo(file?: File) {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Choose a JPEG, PNG, or WebP logo.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Logo must be 5 MB or smaller.')
      return
    }
    setError('')
    setLogoFile(file)
    setLogoPreviewUrl(URL.createObjectURL(file))
    void saveLogo(file)
  }

  async function useSavedLogo(logo: SavedLogo) {
    const file = await logoToFile(logo)
    setError('')
    setLogoFile(file)
    setLogoPreviewUrl(URL.createObjectURL(file))
  }

  function clearPollLogo() {
    setLogoFile(null)
    setLogoPreviewUrl('')
    if (logoInputRef.current) logoInputRef.current.value = ''
  }

  useEffect(() => {
    if (!questionImagePreviewUrl) return
    return () => URL.revokeObjectURL(questionImagePreviewUrl)
  }, [questionImagePreviewUrl])

  function selectQuestionImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    acceptQuestionImage(file)
  }

  function acceptQuestionImage(file?: File) {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Choose a JPEG, PNG, or WebP question image.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Question image must be 5 MB or smaller.')
      return
    }
    setError('')
    setQuestionImageFile(file)
    setQuestionImagePreviewUrl(URL.createObjectURL(file))
  }

  function clearQuestionImage() {
    setQuestionImageFile(null)
    setQuestionImagePreviewUrl('')
  }

  function selectOptionImage(index: number, event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Choose a JPEG, PNG, or WebP option image.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Option images must be 5 MB or smaller.')
      return
    }
    setError('')
    const previewUrl = URL.createObjectURL(file)
    const previousPreviewUrl = options[index]?.previewUrl
    if (previousPreviewUrl) URL.revokeObjectURL(previousPreviewUrl)
    setOptions((current) => current.map((option, optionIndex) => optionIndex === index ? { ...option, imageFile: file, previewUrl } : option))
  }

  function removeOptionImage(index: number) {
    const previewUrl = options[index]?.previewUrl
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setOptions((current) => current.map((option, optionIndex) => optionIndex === index ? { ...option, imageFile: null, previewUrl: '' } : option))
  }

  async function createPoll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isQaMode && (correctOptionIndex === null || !options[correctOptionIndex]?.label.trim())) {
      setError('Choose the correct answer before creating this Q&A.')
      return
    }
    if (isQaMode && questionType === 'image' && !questionImageFile) {
      setError('Upload a question image, or switch to text only.')
      return
    }
    const cleanOptions = options.map((option, index) => ({ ...option, label: option.label.trim(), isCorrect: isQaMode && index === correctOptionIndex })).filter((option) => option.label)
    setError('')
    try {
      const formData = new FormData()
      formData.append('question', question.trim())
      formData.append('isQa', String(isQaMode))
      formData.append('revealCorrect', String(isQaMode && revealCorrect))
      const optionImages: File[] = []
      formData.append('options', JSON.stringify(cleanOptions.map((option) => {
        const imageIndex = option.imageFile ? optionImages.push(option.imageFile) - 1 : null
        return { label: option.label, imageIndex, isCorrect: option.isCorrect }
      })))
      optionImages.forEach((image) => formData.append('optionImages', image))
      if (logoFile) formData.append('logo', logoFile)
      if (isQaMode && questionType === 'image' && questionImageFile) formData.append('questionImage', questionImageFile)
      const response = await fetch('/api/polls', {
        method: 'POST',
        body: formData,
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not create this poll.')
      setPolls((current) => [result, ...current])
      setQuestion('')
      options.forEach((option) => { if (option.previewUrl) URL.revokeObjectURL(option.previewUrl) })
      setOptions(emptyOptionDrafts())
      setCorrectOptionIndex(null)
      setRevealCorrect(false)
      clearPollLogo()
      clearQuestionImage()
      setSharePoll(result)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create this poll.')
    }
  }

  function handleAuthenticated(user: AuthUser) {
    setAuthUser(user)
    setSetupRequired(false)
    setAuthError('')
    if (['/admin/users', '/admin/theme', '/admin/game-theme', '/admin/videos'].includes(window.location.pathname) && user.role !== 'admin') window.location.replace('/')
  }

  async function updatePollSettings(pollId: string, settings: Partial<Pick<Poll, 'votingEnabled' | 'videoEnabled' | 'revealCorrect'>>) {
    try {
      const response = await fetch(`/api/polls/${encodeURIComponent(pollId)}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not update this poll.')
      setPolls((current) => current.map((poll) => poll.id === pollId ? result : poll))
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update this poll.')
    }
  }

  async function deletePoll(poll: Poll) {
    if (!window.confirm(`Delete "${poll.question || 'this Q&A'}"? All participants, answers, and results will be removed.`)) return
    try {
      const response = await fetch(`/api/polls/${encodeURIComponent(poll.id)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not delete this Q&A.')
      setPolls((current) => current.filter((item) => item.id !== poll.id))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete this Q&A.')
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    setAuthUser(null)
  }

  if (resultsPath) return <ResultsDisplay pollId={decodeURIComponent(resultsPath[1])} />
  if (pollPath) return <PollEntry pollId={decodeURIComponent(pollPath[1])} />
  if (gamePath?.[1]) return <VanishingGame roomId={decodeURIComponent(gamePath[1])} />
  if (selfieJoinPath) return <SelfieParticipant token={selfieJoinPath[1]} />
  if (authLoading) return <AuthLoading />
  if (setupRequired) return <LoginPage setupRequired onAuthenticated={handleAuthenticated} initialError={authError} />
  if (!authUser) return <LoginPage onAuthenticated={handleAuthenticated} initialError={authError} />
  if (monitorPath) return <QaMonitor pollId={decodeURIComponent(monitorPath[1])} isAdmin={authUser.role === 'admin'} />
  if (window.location.pathname === '/admin/theme') {
    return authUser.role === 'admin'
      ? <ThemeSettings onBack={() => window.location.assign('/')} />
      : <AccessDeniedPage onLogout={() => void logout()} />
  }
  if (window.location.pathname === '/admin/game-theme') {
    return authUser.role === 'admin'
      ? <ThemeSettings scope="game" onBack={() => window.location.assign('/game')} />
      : <AccessDeniedPage onLogout={() => void logout()} />
  }
  if (window.location.pathname === '/admin/videos') {
    return authUser.role === 'admin'
      ? <AdVideoSettings username={authUser.username} onLogout={() => void logout()} />
      : <AccessDeniedPage onLogout={() => void logout()} />
  }
  if (window.location.pathname === '/admin/users') {
    return authUser.role === 'admin'
      ? <AdminUsersPage currentUser={authUser} onLogout={() => void logout()} />
      : <AccessDeniedPage onLogout={() => void logout()} />
  }
  if (selfiePath) return <SelfieCam />
  if (gamePath && !gamePath[1]) {
    return authUser.role === 'admin'
      ? <GameManagementPage user={authUser} onLogout={() => void logout()} />
      : <AccessDeniedPage onLogout={() => void logout()} />
  }
  if (window.location.pathname !== '/voting') {
    return (
      <ActivityDashboard
        user={authUser}
        onLogout={() => void logout()}
      />
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <ThemeBrand />
        <div className="topbar-actions">
          <a className="button button-quiet manage-users-link" href="/" aria-label="Choose activity" title="Choose activity"><ArrowUpRight size={16} /> Dashboard</a>
          {authUser.role === 'admin' && <>
            <a className="button button-quiet manage-users-link theme-settings-link" href="/admin/theme" aria-label="Appearance and theme settings" title="Appearance and theme settings"><Palette size={16} /> Appearance &amp; Theme Settings</a>
            <a className="button button-quiet manage-users-link" href="/admin/users" aria-label="Manage users" title="Manage users"><Users size={16} /> Manage users</a>
          </>}
          <span className="signed-in-user">{authUser.username}</span>
          <button className="icon-button signout-button" onClick={() => void logout()} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button>
        </div>
      </header>

      <main className="dashboard">
        <section className="workspace-grid">
          <section className="create-panel" aria-labelledby="create-title">
            <div className="section-heading">
              <div><h2 id="create-title">{isQaMode ? 'Create a Q&A' : 'Start a poll'}</h2></div>
            </div>
            <form onSubmit={createPoll} className="poll-form">
              {isQaMode && (
                <div className="question-type-toggle" role="radiogroup" aria-label="Question format">
                  <button type="button" role="radio" aria-checked={questionType === 'text'} className={questionType === 'text' ? 'is-active' : ''} onClick={() => { setQuestionType('text'); clearQuestionImage() }}>Text only</button>
                  <button type="button" role="radio" aria-checked={questionType === 'image'} className={questionType === 'image' ? 'is-active' : ''} onClick={() => setQuestionType('image')}>Image upload</button>
                </div>
              )}
              <label className="field-label" htmlFor="poll-question">{isQaMode && questionType === 'image' ? 'Caption (optional)' : 'Your question'}</label>
              <textarea
                id="poll-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder={isQaMode ? (questionType === 'image' ? 'Add an optional caption for the image' : 'What question should the audience answer?') : 'What should we focus on next?'}
                maxLength={160}
                rows={2}
                required={!(isQaMode && questionType === 'image')}
                minLength={isQaMode && questionType === 'image' ? undefined : 3}
              />
              {isQaMode && questionType === 'image' && (
                <div className="poll-logo-field drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); acceptQuestionImage(event.dataTransfer.files[0]) }}>
                  <input ref={questionImageInputRef} className="logo-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={selectQuestionImage} aria-label="Choose an image for this question" />
                  <div className="logo-preview-tile">{questionImagePreviewUrl ? <img src={questionImagePreviewUrl} alt="Selected question image preview" /> : <ImagePlus size={21} />}</div>
                  <div className="logo-field-copy"><strong>{questionImageFile ? questionImageFile.name : 'Add a question image'}</strong><span>Required · JPEG, PNG, or WebP · 5 MB max</span></div>
                  <button className="button button-secondary logo-picker-button" type="button" onClick={() => questionImageInputRef.current?.click()}>{questionImageFile ? 'Change' : 'Upload'}</button>
                  {questionImageFile && <button className="icon-button logo-remove-button" type="button" onClick={clearQuestionImage} aria-label="Remove question image"><X size={16} /></button>}
                </div>
              )}              <div className="poll-logo-field drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); acceptLogo(event.dataTransfer.files[0]) }}>
                <input ref={logoInputRef} className="logo-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={selectPollLogo} aria-label="Choose a logo for this poll's QR code" />
                <div className="logo-preview-tile">{logoPreviewUrl ? <img src={logoPreviewUrl} alt="Selected QR logo preview" /> : <ImagePlus size={21} />}</div>
                <div className="logo-field-copy"><strong>{logoFile ? logoFile.name : 'Add a QR logo'}</strong><span>Optional · JPEG, PNG, or WebP · 5 MB max</span></div>
                <button className="button button-secondary logo-picker-button" type="button" onClick={() => logoInputRef.current?.click()}>{logoFile ? 'Change' : 'Upload'}</button>
                {logoFile && <button className="icon-button logo-remove-button" type="button" onClick={clearPollLogo} aria-label="Remove QR logo"><X size={16} /></button>}
              </div>
                              <SavedLogoPicker onSelect={(logo) => void useSavedLogo(logo)} />
              <div className="field-row-label">
                <span className="field-label">{isQaMode ? 'Answer options · select the correct answer' : 'Answer options'}</span>
                <span className="field-hint">2 minimum · 8 maximum</span>
              </div>
              <div className="option-list">
                {options.map((option, index) => (
                  <div className="option-input-row" key={index}>
                    <span className={`option-marker marker-${index % 4}`}>{String.fromCharCode(65 + index)}</span>
                    <input
                      aria-label={`Option ${index + 1}`}
                      value={option.label}
                      onChange={(event) => setOptions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))}
                      placeholder={index === 0 ? 'First answer' : index === 1 ? 'Second answer' : `Option ${index + 1}`}
                      maxLength={80}
                    />
                    {isQaMode && <label className="correct-answer-choice" title="Mark this as the correct answer"><input type="radio" name="correct-answer" checked={correctOptionIndex === index} onChange={() => setCorrectOptionIndex(index)} aria-label={`Mark option ${index + 1} as correct`} /><span>Correct</span></label>}
                    <input ref={(element) => { optionImageInputRefs.current[index] = element }} className="option-image-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => selectOptionImage(index, event)} aria-label={`Choose an image for option ${index + 1}`} />
                    <button className="option-image-picker" type="button" onClick={() => optionImageInputRefs.current[index]?.click()} aria-label={`${option.imageFile ? 'Change' : 'Add'} image for option ${index + 1}`} title={option.imageFile ? 'Change option image' : 'Add option image'}>
                      {option.previewUrl ? <img src={option.previewUrl} alt="" /> : <ImagePlus size={17} />}
                    </button>
                    {option.imageFile && <button className="icon-button option-image-remove" type="button" onClick={() => removeOptionImage(index)} aria-label={`Remove image from option ${index + 1}`} title="Remove image"><X size={15} /></button>}
                    {options.length > 2 && (
                      <button className="icon-button remove-option" type="button" aria-label={`Remove option ${index + 1}`} onClick={() => {
                        if (option.previewUrl) URL.revokeObjectURL(option.previewUrl)
                        if (correctOptionIndex === index) setCorrectOptionIndex(null)
                        else if (correctOptionIndex !== null && correctOptionIndex > index) setCorrectOptionIndex(correctOptionIndex - 1)
                        setOptions((current) => current.filter((_, itemIndex) => itemIndex !== index))
                      }}><X size={16} /></button>
                    )}
                  </div>
                ))}
              </div>
              {options.length < 8 && <button className="add-option" type="button" onClick={() => setOptions((current) => [...current, { label: '', imageFile: null, previewUrl: '' }])}><Plus size={15} /> Add an option</button>}
              {isQaMode && <label className="reveal-correct-choice"><input type="checkbox" checked={revealCorrect} onChange={(event) => setRevealCorrect(event.target.checked)} /> Show the correct answer to participants who answer wrong</label>}
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="button button-primary create-button" type="submit" disabled={loading}>
                {isQaMode ? 'Create Q&A' : 'Create poll'} <ArrowUpRight size={17} />
              </button>
            </form>
            <div className="privacy-note"><CircleHelp size={15} /><span>One vote per session. Results update for everyone in the room.</span></div>
          </section>

          <section className="polls-panel" aria-labelledby="polls-title">
            <div className="section-heading polls-heading">
              <div><h2 id="polls-title">{isQaMode ? 'Your Q&A' : 'Your polls'}</h2></div>
              <span className="poll-count">{visiblePolls.length.toString().padStart(2, '0')}</span>
            </div>
            {loading ? <div className="empty-state">{isQaMode ? 'Opening your Q&A…' : 'Opening your polls…'}</div> : visiblePolls.length === 0 ? (
              <div className="empty-state empty-first">
                <div className="empty-icon"><QrCode size={21} /></div>
                <strong>Your next good question starts here.</strong>
                <span>{isQaMode ? 'Q&A questions you create will appear in this list.' : 'Polls you create will appear in this list.'}</span>
              </div>
            ) : (
              <div className="poll-list">
                {visiblePolls.map((poll) => {
                  const totalVotes = poll.options.reduce((total, option) => total + option.votes, 0)
                  return (
                    <article className="poll-row" key={poll.id}>
                      <div className="poll-row-main">
                        <div className="poll-row-meta"><span className="live-indicator" />{totalVotes ? (poll.isQa ? `${totalVotes} ${totalVotes === 1 ? 'answer' : 'answers'}` : `${totalVotes} ${totalVotes === 1 ? 'vote' : 'votes'}`) : 'READY TO SHARE'}<span className="meta-divider">·</span>{poll.isQa ? 'Q&A' : `${poll.options.length} options`}</div>
                        <h3>{poll.question || 'Image question'}</h3>
                        <div className="poll-toggles">
                          <button className={`poll-toggle ${poll.votingEnabled ? 'is-on' : ''}`} type="button" role="switch" aria-checked={poll.votingEnabled} onClick={() => void updatePollSettings(poll.id, { votingEnabled: !poll.votingEnabled })} title={poll.votingEnabled ? 'Click to stop accepting answers' : 'Click to accept answers'}><span className="poll-toggle-knob" />{poll.isQa ? 'Answers' : 'Voting'} {poll.votingEnabled ? 'enabled' : 'disabled'}</button>
                          <button className={`poll-toggle ${poll.videoEnabled ? 'is-on' : ''}`} type="button" role="switch" aria-checked={poll.videoEnabled} onClick={() => void updatePollSettings(poll.id, { videoEnabled: !poll.videoEnabled })} title={poll.videoEnabled ? 'Click to stop playing the video after voting' : 'Click to play the video after voting'}><span className="poll-toggle-knob" />Video {poll.videoEnabled ? 'enabled' : 'disabled'}</button>
                        </div>
                                                  {poll.isQa && (
                                                    <>
                                                      <div className="qa-row-stats" aria-label="Q&A statistics">
                                                        <span><strong>{poll.stats?.participants ?? 0}</strong> participants</span>
                                                        <span><strong>{poll.stats?.submissions ?? 0}</strong> answers</span>
                                                        <span><strong>{poll.stats?.winners ?? 0}</strong> winners</span>
                                                        <span><strong>{poll.stats?.nonWinners ?? 0}</strong> non-winners</span>
                                                      </div>
                                                      <div className="poll-toggles">
                                                        <button className={`poll-toggle ${poll.revealCorrect ? 'is-on' : ''}`} type="button" role="switch" aria-checked={Boolean(poll.revealCorrect)} onClick={() => void updatePollSettings(poll.id, { revealCorrect: !poll.revealCorrect })} title="Show the correct answer to participants who answer wrong"><span className="poll-toggle-knob" />Reveal correct answer {poll.revealCorrect ? 'on' : 'off'}</button>
                                                      </div>
                                                    </>
                                                  )}
                                                </div>
                                                {poll.isQa && <a className="icon-button" href={`/poll/${poll.id}/monitor`} aria-label={`Open live winner monitor for ${poll.question}`} title="Live winner monitor and history"><Users size={18} /></a>}
                                                {!poll.isQa && <button className="icon-button" type="button" onClick={() => setEditPoll(poll)} aria-label={`Edit ${poll.question}`} title="Edit poll"><Pencil size={18} /></button>}
                                                {poll.isQa && <button className="icon-button" type="button" onClick={() => setEditPoll(poll)} aria-label={`Edit ${poll.question}`} title="Edit Q&A"><Pencil size={18} /></button>}
                                                {poll.isQa && <button className="icon-button" type="button" onClick={() => void deletePoll(poll)} aria-label={`Delete ${poll.question}`} title="Delete Q&A"><Trash2 size={18} /></button>}
                      <button className="icon-button poll-share" onClick={() => setSharePoll(poll)} aria-label={`Show QR code for ${poll.question}`} title="Show QR code"><QrCode size={18} /></button>
                      <a className="icon-button poll-display" href={`/poll/${poll.id}/display`} aria-label={`Display live results for ${poll.question}`} title="Display live results"><MonitorPlay size={18} /></a>
                      <a className="poll-open" href={`/poll/${poll.id}`} aria-label={`Open poll: ${poll.question}`}><ChevronRight size={18} /></a>
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        </section>
      </main>

      {sharePoll && <ShareDialog poll={sharePoll} onClose={() => { setSharePoll(null); setCopied(false) }} copied={copied} setCopied={setCopied} />}
      {editPoll && (() => {
        const Dialog = editPoll.isQa ? QaEditDialog : PollEditDialog
        return <Dialog poll={editPoll} onClose={() => setEditPoll(null)} onSaved={(updated) => { setPolls((current) => current.map((item) => item.id === updated.id ? updated : item)); setEditPoll(null) }} />
      })()}
    </div>
  )
}

function ActivityDashboard({
  user,
  onLogout,
}: {
  user: AuthUser
  onLogout: () => void
}) {
  return (
    <div className="activity-shell">
      <header className="topbar">
        <ThemeBrand />
        <div className="topbar-actions">
          {user.role === 'admin' && <>
            <a className="button button-quiet manage-users-link" href="/admin/videos" aria-label="Manage videos" title="Manage videos"><Film size={16} /> Videos</a>
            <a className="button button-quiet manage-users-link theme-settings-link" href="/admin/theme" aria-label="Appearance and theme settings" title="Appearance and theme settings"><Palette size={16} /> Appearance &amp; Theme Settings</a>
            <a className="button button-quiet manage-users-link" href="/admin/users" aria-label="Manage users" title="Manage users"><Users size={16} /> Manage users</a>
          </>}
          <span className="signed-in-user">{user.username}</span>
          <button className="icon-button signout-button" onClick={onLogout} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button>
        </div>
      </header>
      <main className="activity-dashboard">
        <section className="activity-heading">
          <span className="activity-eyebrow">CHOOSE YOUR EXPERIENCE</span>
          <h1>What are we hosting?</h1>
          <p>Run a live Q&A or QR poll, bring two players together, or put a selfie on the big screen.</p>
        </section>
        <section className="activity-options" aria-label="Choose an activity">
          <a className="activity-card qa-activity" href="/voting?mode=qa">
            <span className="activity-card-icon"><CircleHelp size={25} /></span>
            <span className="activity-card-kicker">AUDIENCE Q&amp;A</span>
            <strong>Q&amp;A</strong>
            <span className="activity-card-description">Ask a question with predefined answers for the audience to choose from.</span>
            <span className="activity-card-action">Create a Q&amp;A <ArrowUpRight size={17} /></span>
          </a>
          <a className="activity-card voting-activity" href="/voting">
            <span className="activity-card-icon"><QrCode size={25} /></span>
            <span className="activity-card-kicker">AUDIENCE PARTICIPATION</span>
            <strong>QR Voting</strong>
            <span className="activity-card-description">Create a poll, share its QR code, and watch results update live.</span>
            <span className="activity-card-action">Open voting dashboard <ArrowUpRight size={17} /></span>
          </a>
          <a className="activity-card game-activity" href="/game">
            <span className="activity-card-icon"><Gamepad2 size={25} /></span>
            <span className="activity-card-kicker">TWO-PLAYER MATCH</span>
            <strong>Vanishing Tic-Tac-Toe</strong>
            <span className="activity-card-description">Manage game rooms, customize X and O marks, and invite players by QR code.</span>
            <span className="activity-card-action">{user.role === 'admin' ? 'Open game room management' : 'Admin-managed game rooms'} <ArrowUpRight size={17} /></span>
          </a>
          <a className="activity-card selfie-activity" href="/selfie">
            <span className="activity-card-icon"><Camera size={25} /></span>
            <span className="activity-card-kicker">CAMERA MOMENT</span>
            <strong>Selfie Cam</strong>
            <span className="activity-card-description">Take or upload a portrait and show the whole photo on a full-screen display.</span>
            <span className="activity-card-action">Open Selfie Cam <ArrowUpRight size={17} /></span>
          </a>
        </section>
      </main>
    </div>
  )
}

function GameManagementPage({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [rooms, setRooms] = useState<GameRoomSummary[]>([])
  const [roomLimit, setRoomLimit] = useState(3)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedRoomId, setSelectedRoomId] = useState('')

  async function refreshRooms() {
    try {
      const response = await fetch('/api/admin/games')
      const result = await response.json() as { rooms?: GameRoomSummary[]; limit?: number; error?: string }
      if (!response.ok || !result.rooms) throw new Error(result.error || 'Could not load active game rooms.')
      setRooms(result.rooms)
      setRoomLimit(result.limit || 3)
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load active game rooms.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refreshRooms()
    const timer = window.setInterval(() => void refreshRooms(), 5000)
    return () => window.clearInterval(timer)
  }, [])

  async function createRoom(formData: FormData) {
    setCreating(true)
    setError('')
    try {
      const response = await fetch('/api/games', { method: 'POST', body: formData })
      const result = await response.json() as { id?: string; error?: string }
      if (!response.ok || !result.id) throw new Error(result.error || 'Could not create a game room.')
      setCreateOpen(false)
      setSelectedRoomId(result.id)
      await refreshRooms()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create a game room.')
    } finally {
      setCreating(false)
    }
  }

  async function closeRoom(roomId: string) {
    if (!window.confirm('Close this game room? Both players will lose access to the match.')) return
    try {
      const response = await fetch(`/api/admin/games/${encodeURIComponent(roomId)}`, { method: 'DELETE' })
      const result = response.status === 204 ? null : await response.json() as { error?: string }
      if (!response.ok) throw new Error(result?.error || 'Could not close the game room.')
      if (selectedRoomId === roomId) setSelectedRoomId('')
      await refreshRooms()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not close the game room.')
    }
  }

  return (
    <div className="activity-shell">
      <header className="topbar">
        <ThemeBrand />
        <div className="topbar-actions">
          <a className="button button-quiet manage-users-link" href="/">Dashboard</a>
          <a className="button button-quiet manage-users-link theme-settings-link" href="/admin/game-theme"><Palette size={16} /> Game Appearance &amp; Theme</a>
          <a className="button button-quiet manage-users-link" href="/admin/users"><Users size={16} /> Manage users</a>
          <span className="signed-in-user">{user.username}</span>
          <button className="icon-button signout-button" onClick={onLogout} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button>
        </div>
      </header>
      <main className="activity-dashboard game-management-page">
        <section className="activity-heading game-management-heading">
          <span className="activity-eyebrow">ROOM MANAGEMENT</span>
          <h1>Vanishing Tic-Tac-Toe</h1>
          <p>Create up to {roomLimit} active rooms, upload custom X and O marks, then share each room QR code with its players.</p>
        </section>
        <div className="game-management-toolbar">
          <div><h2>Active game rooms</h2><span>{rooms.length} of {roomLimit} rooms in use</span></div>
          <button className="button button-primary game-admin-create" type="button" onClick={() => setCreateOpen(true)} disabled={rooms.length >= roomLimit}>{rooms.length >= roomLimit ? 'Close a room to create another' : <><Plus size={16} /> Create game room</>}</button>
        </div>
        {error && <p className="activity-card-error" role="alert">{error}</p>}
        {loading ? <p className="active-games-empty">Loading rooms…</p> : rooms.length === 0 ? <p className="active-games-empty">No active rooms. Create one to invite players.</p> : (
          <div className="active-games-list">
            {rooms.map((room) => (
              <article className="active-game-row" key={room.id}>
                <span className={`game-status-dot ${room.status === 'playing' ? 'is-live' : ''}`} />
                <div className="active-game-copy"><strong>{room.roomName}</strong><span>{room.playerXName}{room.playerOName ? ` vs ${room.playerOName}` : ' · Waiting for player'} · {room.status === 'playing' ? 'LIVE GAME' : 'WAITING FOR PLAYERS'}</span></div>
                <button className="button button-secondary active-game-button" type="button" onClick={() => setSelectedRoomId(room.id)}><QrCode size={15} /> Room QR</button>
                <a className="button button-quiet active-game-button" href={`/game/${encodeURIComponent(room.id)}?spectate=1`} target="_blank" rel="noreferrer">Spectate</a>
                <button className="icon-button active-game-close" type="button" onClick={() => void closeRoom(room.id)} aria-label={`Close room with ${room.playerXName}${room.playerOName ? ` and ${room.playerOName}` : ''}`} title="Close room"><X size={16} /></button>
              </article>
            ))}
          </div>
        )}
      </main>
      {createOpen && <CreateGameRoomDialog busy={creating} error={error} onClose={() => { setCreateOpen(false); setError('') }} onCreate={(formData) => void createRoom(formData)} />}
      {selectedRoomId && <GameRoomDialog roomId={selectedRoomId} onClose={() => setSelectedRoomId('')} />}
    </div>
  )
}

function CreateGameRoomDialog({ busy, error, onClose, onCreate }: {
  busy: boolean
  error: string
  onClose: () => void
  onCreate: (formData: FormData) => void
}) {
  const [xImage, setXImage] = useState<File | null>(null)
  const [oImage, setOImage] = useState<File | null>(null)
  const [roomName, setRoomName] = useState('')
  const [xPreview, setXPreview] = useState('')
  const [oPreview, setOPreview] = useState('')
  const [validationError, setValidationError] = useState('')
  const [pieceStyle, setPieceStyle] = useState<'letters' | 'photo'>('letters')

  useEffect(() => {
    if (xPreview) return () => URL.revokeObjectURL(xPreview)
  }, [xPreview])

  useEffect(() => {
    if (oPreview) return () => URL.revokeObjectURL(oPreview)
  }, [oPreview])

  function choosePiece(player: 'X' | 'O', event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setValidationError('Choose a JPEG, PNG, or WebP image.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setValidationError('Each player image must be 5 MB or smaller.')
      return
    }
    setValidationError('')
    const preview = URL.createObjectURL(file)
    if (player === 'X') {
      setXImage(file)
      setXPreview(preview)
    } else {
      setOImage(file)
      setOPreview(preview)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pieceStyle === 'photo' && (!xImage || !oImage)) {
      setValidationError('Upload a photo for both Player X and Player O.')
      return
    }
    setValidationError('')
    const formData = new FormData()
    formData.append('roomName', roomName.trim())
    formData.append('pieceStyle', pieceStyle)
    if (pieceStyle === 'photo' && xImage && oImage) {
      formData.append('xImage', xImage)
      formData.append('oImage', oImage)
    }
    onCreate(formData)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <form className="modal create-game-modal" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="create-game-title">
        <button className="icon-button modal-close" type="button" onClick={onClose} aria-label="Close" disabled={busy}><X size={19} /></button>
        <div className="modal-kicker"><span className="live-indicator" /> NEW GAME ROOM</div>
        <h2 id="create-game-title">Name your game room</h2>
        <label className="game-room-name-field" htmlFor="game-room-name">Room name</label>
        <input id="game-room-name" className="game-room-name-input" value={roomName} onChange={(event) => setRoomName(event.target.value)} maxLength={60} placeholder="e.g. Team Final" required autoFocus />
        <fieldset className="game-piece-style" disabled={busy}>
          <legend>Game pieces</legend>
          <label><input type="radio" name="piece-style" checked={pieceStyle === 'letters'} onChange={() => { setPieceStyle('letters'); setValidationError('') }} /> Letters X and O</label>
          <label><input type="radio" name="piece-style" checked={pieceStyle === 'photo'} onChange={() => { setPieceStyle('photo'); setValidationError('') }} /> Custom photos</label>
        </fieldset>
        {pieceStyle === 'photo' && <><p className="game-upload-description">A photo is required for both players. Players and the spectator view will use these images on the board.</p>
        <div className="game-piece-upload-grid">
          {([
            { player: 'X' as const, file: xImage, preview: xPreview },
            { player: 'O' as const, file: oImage, preview: oPreview },
          ]).map(({ player, file, preview }) => (
            <label className="game-piece-upload" key={player}>
              <span className={`game-piece-preview mark-${player.toLowerCase()}`}>{preview ? <img src={preview} alt={`${player} mark preview`} /> : player}</span>
              <span className="game-piece-info"><strong>Player {player}</strong><small>{file ? file.name : 'Required · JPEG, PNG, WebP · 5 MB max'}</small></span>
              <span className="button button-secondary game-piece-button">{file ? 'Change' : 'Upload'}<ImagePlus size={15} /></span>
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => choosePiece(player, event)} aria-label={`Upload image for player ${player}`} />
            </label>
          ))}
        </div></>}
        {(validationError || error) && <p className="form-error" role="alert">{validationError || error}</p>}
        <div className="create-game-actions">
          <button className="button button-quiet" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button button-primary game-admin-create" type="submit" disabled={busy}>{busy ? 'Creating room…' : <><QrCode size={16} /> Create room &amp; QR</>}</button>
        </div>
      </form>
    </div>
  )
}

function GameRoomDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const [shareUrl, setShareUrl] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    void getGameShareUrl(roomId)
      .then((url) => { if (active) setShareUrl(url) })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : 'Could not prepare the game QR code.') })
    return () => { active = false }
  }, [roomId])

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
    } catch {
      setError('Could not copy the join link. Players can scan the QR code instead.')
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="modal share-modal game-room-dialog" role="dialog" aria-modal="true" aria-labelledby="game-room-title">
        <button className="icon-button modal-close" onClick={onClose} aria-label="Close"><X size={19} /></button>
        <div className="modal-kicker"><span className="live-indicator" /> ROOM IS READY</div>
        <h2 id="game-room-title">Invite two players</h2>
        <p className="share-question">Both players scan this QR code to join the same game.</p>
        <div className="qr-frame">{shareUrl ? <PollQrCode value={shareUrl} size={240} label="QR code for the Vanishing Tic-Tac-Toe room" /> : <span className="scan-caption">{error || 'Preparing QR code…'}</span>}</div>
        <p className="scan-caption">Each phone joins as the next available player</p>
        <p className="share-help">The first scan claims X. The second claims O.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-secondary copy-button" onClick={() => void copyLink()} disabled={!shareUrl}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Link copied' : 'Copy join link'}</button>
        <a className="share-open-link" href={`/game/${encodeURIComponent(roomId)}?spectate=1`} target="_blank" rel="noreferrer">Spectate this game <ArrowUpRight size={14} /></a>
        <a className="share-open-link" href={shareUrl}>Open game room <ArrowUpRight size={14} /></a>
      </section>
    </div>
  )
}

function ShareDialog({ poll, onClose, copied, setCopied }: { poll: Poll; onClose: () => void; copied: boolean; setCopied: (value: boolean) => void }) {
  const [shareUrl, setShareUrl] = useState('')
  const [presenting, setPresenting] = useState(false)

  useEffect(() => {
    if (!presenting) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPresenting(false) }
    const exit = () => { if (!document.fullscreenElement) setPresenting(false) }
    window.addEventListener('keydown', close)
    document.addEventListener('fullscreenchange', exit)
    return () => { window.removeEventListener('keydown', close); document.removeEventListener('fullscreenchange', exit) }
  }, [presenting])

  function present() {
    setPresenting(true)
    void document.documentElement.requestFullscreen?.().catch(() => undefined)
  }

  function stopPresenting() {
    setPresenting(false)
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
  }

  useEffect(() => {
    let active = true
    void getPollShareUrl(poll.id).then((url) => { if (active) setShareUrl(url) })
    return () => { active = false }
  }, [poll.id])

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="modal share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <button className="icon-button modal-close" onClick={onClose} aria-label="Close"><X size={19} /></button>
        <div className="modal-kicker"><QrCode size={15} /> <span id="share-title">{poll.joinTitle || (poll.isQa ? 'JOIN THE Q&A' : 'JOIN THE VOTE')}</span></div>
        <p className="share-question">{poll.question || 'Image question'}</p>
        <div className="qr-frame">{shareUrl ? <PollQrCode value={shareUrl} logoUrl={poll.logoUrl} size={240} label="QR code for this poll" /> : <span className="scan-caption">Preparing QR code…</span>}</div>
        <p className="scan-caption">Open your camera and point it here</p>
        <p className="share-help">Keep your phone on the same Wi-Fi network, then scan the QR to open the poll.</p>
        <button className="button button-secondary copy-button" onClick={() => void copyLink()} disabled={!shareUrl}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Link copied' : 'Copy poll link'}</button>
        <div className="qr-actions">
          <button className="button button-secondary" type="button" onClick={() => void downloadQrPng(shareUrl, poll.logoUrl, `qr-${poll.id.slice(0, 8)}.png`)} disabled={!shareUrl}><Download size={16} /> Download PNG</button>
          <button className="button button-secondary" type="button" onClick={present} disabled={!shareUrl}><Maximize size={16} /> Full screen</button>
        </div>
        <a className="share-open-link" href={shareUrl}>Open voting page <ArrowUpRight size={14} /></a>
      </section>
      {presenting && shareUrl && (
        <div className="qr-presentation" role="dialog" aria-modal="true" aria-label="QR code presentation" onClick={stopPresenting}>
          <h2>{poll.question || 'Scan to join'}</h2>
          <div className="qr-presentation-code"><PollQrCode value={shareUrl} logoUrl={poll.logoUrl} size={Math.round(Math.min(window.innerWidth * 0.8, window.innerHeight * 0.65))} label="QR code" /></div>
          <p>Scan with your phone camera · press Esc or click to exit</p>
        </div>
      )}
    </div>
  )
}

function PollEntry({ pollId }: { pollId: string }) {
  const [poll, setPoll] = useState<Poll | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    fetch(`/api/polls/${encodeURIComponent(pollId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('missing')
        const data: Poll = await response.json()
        if (active) setPoll(data)
      })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [pollId])

  if (poll?.isQa) return <QaAudience pollId={pollId} initialPoll={poll} />
  if (poll || failed) return <VotePage pollId={pollId} />
  return <div className="vote-shell"><main className="vote-main"><div className="vote-card"><div className="skeleton-line" /></div></main></div>
}

function VotePage({ pollId }: { pollId: string }) {
  const [poll, setPoll] = useState<Poll | null>(null)
  const [selected, setSelected] = useState('')
  const [voted, setVoted] = useState(false)
  const [showAd, setShowAd] = useState(false)
  const [sessionReady, setSessionReady] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const response = await fetch(`/api/polls/${encodeURIComponent(pollId)}`)
        if (!response.ok) throw new Error('This poll may have been removed or the link may be incorrect.')
        const data: Poll = await response.json()
        if (active) setPoll(data)
        const sessionResponse = await fetch(`/api/polls/${encodeURIComponent(pollId)}/session`, { method: 'POST' })
        const session = await sessionResponse.json()
        if (!sessionResponse.ok) throw new Error(session.error || 'Could not start your voting session.')
        if (active) {
          setSessionReady(true)
          setVoted(Boolean(session.voted))
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not open this poll.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [pollId])

  useEffect(() => {
    if (!poll || voted) return
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/polls/${encodeURIComponent(pollId)}`)
        if (response.ok) setPoll(await response.json())
      } catch { /* Keep the last visible results while reconnecting. */ }
    }, 3000)
    return () => window.clearInterval(timer)
  }, [pollId, poll, voted])

  async function castVote() {
    if (!selected || !sessionReady) return
    setError('')
    try {
      const response = await fetch(`/api/polls/${encodeURIComponent(pollId)}/votes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId: selected }),
      })
      const result = await response.json()
      if (response.status === 409) {
        setVoted(true)
        setError('')
        const latestResponse = await fetch(`/api/polls/${encodeURIComponent(pollId)}`)
        if (latestResponse.ok) setPoll(await latestResponse.json())
        return
      }
      if (response.status === 423) {
        const latestResponse = await fetch(`/api/polls/${encodeURIComponent(pollId)}`)
        if (latestResponse.ok) setPoll(await latestResponse.json())
        return
      }
      if (!response.ok) throw new Error(result.error || 'Your vote could not be recorded.')
      setPoll(result)
      setVoted(true)
      setShowAd(Boolean(result.videoEnabled))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Your vote could not be recorded.')
    }
  }

  const totalVotes = poll?.options.reduce((total, option) => total + option.votes, 0) ?? 0

  return (
    <div className="vote-shell">
      {showAd && <AdVideoOverlay kind="poll" onDone={() => setShowAd(false)} />}
      <header className="vote-topbar"><ThemeBrand /><span className="vote-top-label">A QUICK ROOM POLL</span></header>
      <main className="vote-main">
        {loading ? <div className="vote-card"><div className="skeleton-line" /><div className="skeleton-line short" /></div> : error && !poll ? (
          <div className="vote-card not-found"><div className="empty-icon"><CircleHelp size={21} /></div><h1>Poll not found.</h1><p>{error}</p><p>Check the QR code and try again.</p></div>
        ) : poll ? (
          <section className="vote-card">
            <div className="vote-card-kicker"><span className="live-indicator" /> LIVE POLL <span className="kicker-divider">/</span> {`${totalVotes} ${totalVotes === 1 ? 'VOTE' : 'VOTES'}`}</div>
            {poll.questionImageUrl && <img className="question-image" src={poll.questionImageUrl} alt={poll.question || 'Question'} />}
            {(poll.question || !poll.questionImageUrl) && <h1>{poll.question}</h1>}
            <p className="vote-instruction">{voted ? 'You have already voted. Thank you!' : !poll.votingEnabled ? 'Voting is currently closed. Check back soon.' : 'Choose one answer. Each voting session can vote once.'}</p>
            <div className="vote-options">
              {poll.options.map((option, index) => {
                const percent = totalVotes ? Math.round(option.votes / totalVotes * 100) : 0
                return (
                  <button key={option.id} className={`vote-option ${selected === option.id ? 'is-selected' : ''} ${voted ? 'show-result' : ''}`} disabled={voted || !poll.votingEnabled} onClick={() => setSelected(option.id)}>
                    {voted && <span className="result-fill" style={{ width: `${percent}%` }} />}
                    <span className={`option-marker marker-${index % 4}`}>{String.fromCharCode(65 + index)}</span>
                    {option.imageUrl && <img className="vote-option-image" src={option.imageUrl} alt="" />}
                    <span className="vote-option-label">{option.label}</span>
                    {voted ? <span className="vote-percent">{percent}% <small>{option.votes}</small></span> : <span className="radio-mark" />}
                  </button>
                )
              })}
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
            {sessionReady && !voted && poll.votingEnabled && <button className="button button-primary submit-vote" onClick={() => void castVote()} disabled={!selected}>Cast my vote <ArrowUpRight size={17} /></button>}
            {voted && <div className="vote-confirmation" role="status"><Check size={16} /> Vote recorded · one vote per session</div>}
            <div className="vote-card-foot"><span>VOTE <span className="footer-dot">/</span> EVERY VOICE COUNTS</span></div>
          </section>
        ) : null}
      </main>
    </div>
  )
}

function ResultsDisplay({ pollId }: { pollId: string }) {
  const [poll, setPoll] = useState<Poll | null>(null)
  const [error, setError] = useState('')
  const [shareUrl, setShareUrl] = useState('')

  useEffect(() => {
    let active = true
    async function refresh() {
      try {
        const response = await fetch(`/api/polls/${encodeURIComponent(pollId)}`)
        if (!response.ok) throw new Error('This poll could not be found.')
        const data: Poll = await response.json()
        if (active) {
          setPoll(data)
          setError('')
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not load live results.')
      }
    }

    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [pollId])

  useEffect(() => {
    function enterFullscreen() {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => undefined)
    }
    // Browsers only allow fullscreen after a user gesture, so retry on the first interaction.
    enterFullscreen()
    window.addEventListener('pointerdown', enterFullscreen, { once: true })
    window.addEventListener('keydown', enterFullscreen, { once: true })
    function exitFullscreen() {
      if (document.fullscreenElement) void document.exitFullscreen()
    }
    window.addEventListener('dblclick', exitFullscreen)
    return () => {
      window.removeEventListener('pointerdown', enterFullscreen)
      window.removeEventListener('keydown', enterFullscreen)
      window.removeEventListener('dblclick', exitFullscreen)
    }
  }, [])

  useEffect(() => {
    let active = true
    void getPollShareUrl(pollId).then((url) => { if (active) setShareUrl(url) })
    return () => { active = false }
  }, [pollId])

  if (!poll) {
    return <main className="display-loading">{error || 'Loading live results…'}</main>
  }

  const totalVotes = poll.isQa ? 0 : poll.options.reduce((total, option) => total + option.votes, 0)
  const leadingVotes = Math.max(...poll.options.map((option) => option.votes), 0)
  const leader = poll.options.find((option) => option.votes === leadingVotes && leadingVotes > 0)

  return (
    <main className="display-shell">
      <section className="display-heading">
        <div>
          {poll.questionImageUrl &&  <img className="question-image display-question-image" src={poll.questionImageUrl} alt={poll.question || 'Question'} />}
          {(poll.question || !poll.questionImageUrl) && <h1>{poll.question}</h1>}
        </div>
      </section>
      <section className="display-grid">
        <div className="display-results" aria-label={poll.isQa ? 'First correct Q&A answer' : 'Live poll results'}>
          {poll.isQa ? (
            <article className="qa-winner-card" aria-live="polite">
              <span className="qa-winner-eyebrow">{poll.winnerName ? 'FIRST CORRECT ANSWER' : 'WAITING FOR THE FIRST CORRECT ANSWER'}</span>
              {poll.winnerName ? (
                <>
                  <span className="qa-winner-trophy" aria-hidden="true">🏆</span>
                  <h2>{poll.winnerName}</h2>
                  {poll.winnerTicketNumber && <p>Ticket number: <strong>{poll.winnerTicketNumber}</strong></p>}
                  {poll.winnerAnswer && <p>Correct answer: <strong>{poll.winnerAnswer}</strong></p>}
                </>
              ) : <p>Be the first to answer correctly.</p>}
            </article>
          ) : (
            <>
              {poll.options.map((option, index) => {
                const percent = totalVotes ? Math.round(option.votes / totalVotes * 100) : 0
                return (
                  <article className={`display-result result-tone-${index % 4}`} key={option.id}>
                    <span className="display-result-image">{option.imageUrl && <img src={option.imageUrl} alt="" />}</span>
                    <div className="display-result-body">
                      <div className="display-result-top">
                        <span className="display-result-index">{String(index + 1).padStart(2, '0')}</span>
                        <h2>{option.label}</h2>
                        <span className="display-result-percent">{percent}<small>%</small></span>
                      </div>
                      <div className="display-meter"><span style={{ width: `${percent}%` }} /></div>
                      <div className="display-result-count">{option.votes.toLocaleString()} {option.votes === 1 ? 'VOTE' : 'VOTES'}</div>
                    </div>
                  </article>
                )
              })}
              {leader && <div className="display-leader"><span className="leader-star">★</span><span>IN THE LEAD</span><strong>{leader.label}</strong></div>}
            </>
          )}
        </div>
        <aside className="display-join">
          <div className="display-qr">{shareUrl && poll ? <PollQrCode value={shareUrl} logoUrl={poll.logoUrl} size={480} label={poll.isQa ? 'Scan to join this Q&A' : 'Scan to vote in this poll'} /> : <span>Loading QR…</span>}</div>
          <p className="display-scan">{poll.isQa ? 'SCAN TO JOIN!' : 'SCAN TO VOTE!'}</p>
        </aside>
      </section>
    </main>
  )
}

function AuthLoading() {
  return <main className="auth-shell"><div className="auth-loading">Checking access…</div></main>
}

function LoginPage({ setupRequired = false, initialError = '', onAuthenticated }: { setupRequired?: boolean; initialError?: string; onAuthenticated: (user: AuthUser) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(initialError)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const response = await fetch(setupRequired ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Sign-in failed.')
      onAuthenticated(result.user)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-shell">
      <header className="auth-topbar"><ThemeBrand /></header>
      <section className="auth-layout">
        <div className="auth-intro"><span className="auth-eyebrow">HOST ACCESS</span><h1>{setupRequired ? 'Set up your admin account.' : 'Welcome back.'}</h1><p>{setupRequired ? 'Create the first admin account to manage polls and add other users.' : 'Sign in to create polls and manage your audience displays.'}</p></div>
        <form className="auth-form" onSubmit={submit}>
          <div className="auth-form-heading"><span className="auth-icon">{setupRequired ? <Shield size={19} /> : <LogIn size={19} />}</span><div><h2>{setupRequired ? 'Initial setup' : 'Sign in'}</h2><span>{setupRequired ? 'First account becomes admin' : 'Use your account'}</span></div></div>
          <label className="auth-field-label" htmlFor="auth-username">Username</label>
          <input id="auth-username" autoComplete="username" minLength={3} maxLength={40} value={username} onChange={(event) => setUsername(event.target.value)} required />
          <label className="auth-field-label" htmlFor="auth-password">Password</label>
          <input id="auth-password" type="password" autoComplete={setupRequired ? 'new-password' : 'current-password'} minLength={setupRequired ? 12 : undefined} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required />
          {setupRequired && <p className="auth-hint">Use at least 12 characters. You can add other accounts after signing in.</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button button-primary auth-submit" type="submit" disabled={busy}>{setupRequired ? <UserPlus size={17} /> : <LogIn size={17} />}{busy ? 'Please wait…' : setupRequired ? 'Create admin account' : 'Sign in'}</button>
        </form>
      </section>
    </main>
  )
}

function AdminUsersPage({ currentUser, onLogout }: { currentUser: AuthUser; onLogout: () => void }) {
  const [users, setUsers] = useState<AuthUser[]>([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'admin' | 'host'>('host')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/api/admin/users')
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Could not load users.')
        return result as (AuthUser & { createdAt: string })[]
      })
      .then((result) => { if (active) setUsers(result) })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : 'Could not load users.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  async function addUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, role }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not add user.')
      setUsers((current) => [...current, result.user])
      setUsername('')
      setPassword('')
      setRole('host')
      setNotice(`${result.user.username} has been added.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add user.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="admin-shell">
      <header className="admin-topbar"><ThemeBrand /><div className="admin-top-actions"><span>{currentUser.username} · ADMIN</span><button className="icon-button signout-button" onClick={onLogout} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button></div></header>
      <div className="admin-content">
        <a className="admin-back" href="/">← Dashboard</a>
        <div className="admin-heading"><span className="auth-eyebrow">ACCOUNT CONTROL</span><h1>Manage users</h1><p>Add a host or another admin account.</p></div>
        <div className="admin-grid">
          <form className="admin-form" onSubmit={addUser}>
            <div className="admin-form-title"><UserPlus size={18} /><h2>Add a user</h2></div>
            <label className="auth-field-label" htmlFor="new-username">Username</label>
            <input id="new-username" autoComplete="off" minLength={3} maxLength={40} value={username} onChange={(event) => setUsername(event.target.value)} required />
            <label className="auth-field-label" htmlFor="new-password">Temporary password</label>
            <input id="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required />
            <p className="auth-hint">At least 12 characters. Share it with the user securely.</p>
            <label className="auth-field-label" htmlFor="new-role">Role</label>
            <select id="new-role" value={role} onChange={(event) => setRole(event.target.value as 'admin' | 'host')}><option value="host">Host · create and manage polls</option><option value="admin">Admin · manage users and polls</option></select>
            {error && <p className="form-error" role="alert">{error}</p>}
            {notice && <p className="auth-success" role="status">{notice}</p>}
            <button className="button button-primary auth-submit" type="submit" disabled={saving}><UserPlus size={17} />{saving ? 'Adding…' : 'Add user'}</button>
          </form>
          <section className="admin-user-list" aria-labelledby="users-title">
            <div className="admin-form-title"><Users size={18} /><h2 id="users-title">Accounts</h2><span>{users.length}</span></div>
            {loading ? <p className="auth-hint">Loading accounts…</p> : users.map((user) => <div className="admin-user-row" key={user.id}><span className="admin-user-avatar">{user.username.slice(0, 1).toUpperCase()}</span><span className="admin-user-name">{user.username}<small>{user.id === currentUser.id ? 'You' : 'VOTE account'}</small></span><span className={`role-tag role-${user.role}`}>{user.role}</span></div>)}
          </section>
        </div>
      </div>
    </main>
  )
}

function AccessDeniedPage({ onLogout }: { onLogout: () => void }) {
  return <main className="auth-shell"><section className="access-denied"><Shield size={30} /><h1>Admin access required.</h1><p>Your account can manage polls but cannot manage users.</p><a className="button button-secondary" href="/">Back to dashboard</a><button className="button button-quiet" onClick={onLogout}>Sign out</button></section></main>
}

export default App