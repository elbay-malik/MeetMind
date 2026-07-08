import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AppLogo from '~/components/AppLogo.vue'

describe('AppLogo', () => {
  it('renders the product name', async () => {
    const wrapper = await mountSuspended(AppLogo)
    expect(wrapper.text()).toContain('MeetMind')
  })
})
