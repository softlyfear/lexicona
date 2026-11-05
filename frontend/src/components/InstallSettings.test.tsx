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
    expect(screen.getByRole('region', { name: 'Установка' })).toHaveTextContent('Установка')
    await user.click(screen.getByRole('button', { name: 'Установить' }))
    expect(prompt).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Установить' })).not.toBeInTheDocument()
  })

  it('без системного приглашения ничего не показывает и скрывает сбой диалога', async () => {
    const { container } = render(<InstallSettings />)
    expect(container).toBeEmptyDOMElement()
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: vi.fn().mockRejectedValue(new Error('failed')),
    })
    act(() => window.dispatchEvent(event))
    await userEvent.click(screen.getByRole('button', { name: 'Установить' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Установить' })).not.toBeInTheDocument()
  })

  it('скрывает кнопку в standalone и после установки', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { unmount, container } = render(<InstallSettings />)
    expect(container).toBeEmptyDOMElement()
    unmount()
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: vi.fn(),
    })
    window.dispatchEvent(event)
    render(<InstallSettings />)
    expect(screen.getByRole('button', { name: 'Установить' })).toBeInTheDocument()
    act(() => window.dispatchEvent(new Event('appinstalled')))
    expect(screen.queryByRole('button', { name: 'Установить' })).not.toBeInTheDocument()
  })

  it('удаляет слушатели при завершении работы', () => {
    stop()
    const event = new Event('beforeinstallprompt', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    const { container } = render(<InstallSettings />)
    expect(container).toBeEmptyDOMElement()
  })
})
