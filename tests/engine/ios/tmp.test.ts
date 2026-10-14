import { it } from 'vitest'
import { router } from './helpers'
it('x', () => {
  const c = router()
  c.lines('en')
  console.log(c.run('show running-config').join('\n'))
  console.log(c.run('show ip interface brief').join('\n'))
})
