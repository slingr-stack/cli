import { createServer } from 'net'
import { execSync } from 'child_process'

/**
 * Check if Docker is using a port
 */
function isDockerUsingPort(port: number): boolean {
    try {
        const output = execSync(`docker ps --format "table {{.Ports}}" | grep ":${port}->"`, { encoding: 'utf-8' })
        return output.trim().length > 0
    } catch (error) {
        return false
    }
}

/**
 * Check if a port is available
 */
export function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        // First check if Docker is using the port
        if (isDockerUsingPort(port)) {
            resolve(false)
            return
        }

        const server = createServer()

        server.once('error', (err: any) => {
            if (err.code === 'EADDRINUSE') {
                resolve(false)
            } else {
                resolve(false)
            }
        })

        server.once('listening', () => {
            server.close(() => {
                resolve(true)
            })
        })

        server.listen(port, '127.0.0.1')
    })
}

/**
 * Find an available port starting from a given port
 */
export async function findAvailablePort(startPort: number, maxPort: number = startPort + 100): Promise<number> {
    for (let port = startPort; port <= maxPort; port++) {
        if (await isPortAvailable(port)) {
            return port
        }
    }
    throw new Error(`No available port found in range ${startPort}-${maxPort}`)
}

/**
 * Get default port for database type
 */
export function getDefaultPort(dbType: string): number {
    switch (dbType.toLowerCase()) {
        case 'postgres':
        case 'postgresql':
            return 5432
        case 'mysql':
            return 3306
        case 'redis':
            return 6379
        default:
            return 5432
    }
}

/**
 * Find available port for database type
 */
export async function findDatabasePort(dbType: string): Promise<number> {
    const defaultPort = getDefaultPort(dbType)

    // First try the default port
    if (await isPortAvailable(defaultPort)) {
        return defaultPort
    }

    // If default port is not available, find next available port
    return await findAvailablePort(defaultPort + 1)
}
