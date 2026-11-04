export default defineAppConfig({
  ui: {
    alert: {
      // The theme sets the words in the colour itself on its own 10% tint: amber measures 1.78:1
      // and red 3.28:1 in light mode, where 4.5:1 is the minimum. The colour stays on the icon and border.
      compoundVariants: (['warning', 'error'] as const).map(color => ({
        color,
        variant: 'subtle' as const,
        class: { title: 'text-highlighted', description: 'text-default opacity-100' },
      })),
    },
  },
})
