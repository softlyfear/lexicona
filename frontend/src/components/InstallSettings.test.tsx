import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listenForInstall } from '../install'
import { InstallSettings } from './InstallSettings'

let stop: () => void
beforeEach(() => {
  stop = listenForInstall()
})
afterEach(() => {
  stop()
  vi.unstubAllGlobals()
})

describe('установка приложения', () => {
  it('сохраняет событие до открытия настроек и вызывает системный диалог только один раз', async () => {
    const prompt = vi.fn().mockResolvedValue({ outcome: 'dismissed' })
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    render(<InstallSettings />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Установить приложение' }))
    expect(prompt).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Установить приложение' })).not.toBeInTheDocument()
    expect(screen.getByText(/Android, Chrome/)).toBeInTheDocument()
  })

  it('показывает инструкции без системного приглашения и сообщает об ошибке', async () => {
    render(<InstallSettings />)
    expect(screen.getByText(/iPhone или iPad, Safari/)).toBeInTheDocument()
    expect(screen.getByText(/HTTPS/)).toBeInTheDocument()
    expect(screen.getByText(/подключение к интернету/)).toBeInTheDocument()
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: vi.fn().mockRejectedValue(new Error('failed')),
    })
    act(() => window.dispatchEvent(event))
    await userEvent.click(screen.getByRole('button', { name: 'Установить приложение' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось открыть установку')
  })

  it('скрывает инструкции в standalone и очищает приглашение после установки', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { unmount } = render(<InstallSettings />)
    expect(screen.getByText(/Приложение открыто или установлено/)).toBeInTheDocument()
    expect(screen.queryByText(/Android, Chrome/)).not.toBeInTheDocument()
    unmount()
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: vi.fn(),
    })
    window.dispatchEvent(event)
    render(<InstallSettings />)
    expect(screen.getByRole('button', { name: 'Установить приложение' })).toBeInTheDocument()
    act(() => window.dispatchEvent(new Event('appinstalled')))
    expect(screen.queryByRole('button', { name: 'Установить приложение' })).not.toBeInTheDocument()
    expect(screen.getByText(/Приложение открыто или установлено/)).toBeInTheDocument()
  })

  it('удаляет слушатели при завершении работы', () => {
    stop()
    const event = new Event('beforeinstallprompt', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    render(<InstallSettings />)
    expect(screen.queryByRole('button', { name: 'Установить приложение' })).not.toBeInTheDocument()
  })
})
