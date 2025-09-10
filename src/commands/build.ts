import { Command } from '@oclif/core'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

export default class Build extends Command {
    static description = 'Build the Slingr CLI'

    static examples = ['<%= config.bin %> <%= command.id %>']

    static aliases = ['build']
    static strict = false

    public async run(): Promise<void> {
        const __filename = fileURLToPath(import.meta.url)
        const __dirname = dirname(__filename)
        const cliRootPath = join(__dirname, '..', '..')

        try {
            this.log('Building Slingr CLI...')
            execSync('npm run build', {
                cwd: cliRootPath,
                stdio: 'inherit'
            })
            this.log('Build completed successfully!')
        } catch (error) {
            this.error('Failed to build Slingr CLI')
            throw error
        }
    }
}
