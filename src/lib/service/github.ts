/**
 * houston/src/lib/service/github.ts
 * Handles interaction with GitHub repositories.
 *
 * NOTE: If you are using a personal auth token, the url should be like so:
 * "https://x-access-token:asdf1234@github.com/elementary/houston"
 */

import * as fileType from 'file-type'
import * as fs from 'fs-extra'
import { inject, injectable, LazyServiceIdentifer } from 'inversify'
import * as jsonwebtoken from 'jsonwebtoken'
import * as Git from 'nodegit'
import * as os from 'os'
import * as path from 'path'
import * as agent from 'superagent'
import * as URL from 'url'
import * as uuid from 'uuid/v4'

import { App } from '../app'
import { Cache, ICache, ICacheFactory } from '../cache'
import { Config } from '../config'
import { sanitize } from '../utility/rdnn'
import * as type from './type'

export const github = Symbol('GitHub')
export type IGitHubFactory = (url: string) => GitHub

@injectable()
export class GitHub implements type.ICodeRepository, type.IPackageRepository, type.ILogRepository {
  /**
   * Folder to use as scratch space for cloning repos
   *
   * @var {string}
   */
  public tmpFolder = path.resolve(os.tmpdir(), 'houston')

  /**
   * The human readable name of the service.
   *
   * @var {String}
   */
  public serviceName = 'GitHub'

  /**
   * The host for the repo. This is almost always "github.com" but can change if
   * you have an enterprise instance.
   *
   * @var {string}
   */
  public host = 'github.com'

  /**
   * The GitHub username or organization.
   *
   * @var {string}
   */
  public username: string

  /**
   * The GitHub user's repository name
   *
   * @var {string}
   */
  public repository: string

  /**
   * The http username
   *
   * @var {string|null}
   */
  public authUsername?: string

  /**
   * The http password authentication string.
   * NOTE: When the `authUsername` is 'installation', this will be an
   * installation id. Not an accurate http password.
   *
   * @var {string|null}
   */
  public authPassword?: string

  /**
   * The reference to branch or tag.
   *
   * @var {string}
   */
  public reference = 'refs/heads/master'

  /**
   * The application configuration
   *
   * @var {Config}
   */
  protected config: Config

  /**
   * A cache store for GitHub authentication tokens
   *
   * @var {Cache}
   */
  protected cache: ICache

  /**
   * Tries to get the file mime type by reading the first chunk of a file.
   * Required by GitHub API
   *
   * Code taken from examples of:
   * https://github.com/sindresorhus/file-type
   * https://github.com/sindresorhus/read-chunk/blob/master/index.js
   *
   * @async
   * @param {String} p Full file path
   * @return {String} The file mime type
   */
  protected static async getFileType (p: string): Promise<string> {
    const buffer = await new Promise((resolve, reject) => {
      fs.open(p, 'r', (openErr, fd) => {
        if (openErr != null) {
          return reject(openErr)
        }

        fs.read(fd, Buffer.alloc(4100), 0, 4100, 0, (readErr, bytesRead, buff) => {
          fs.close(fd)

          if (readErr != null) {
            return reject(readErr)
          }

          if (bytesRead < 4100) {
            return resolve(buff.slice(0, bytesRead))
          } else {
            return resolve(buff)
          }
        })
      })
    })

    return fileType(buffer).mime
  }

  /**
   * Creates a new GitHub Repository
   *
   * @param {App} app - The application IOC instance
   */
  constructor (@inject(new LazyServiceIdentifer(() => App)) app: App) {
    this.config = app.get(Config)
    this.cache = app.get<ICacheFactory>(Cache)('lib/service/github')
  }

  /**
   * Returns the default RDNN value for this repository
   *
   * @return {string}
   */
  public get rdnn () {
    return sanitize(`com.github.${this.username}.${this.repository}`)
  }

  /**
   * Returns the Git URL for the repository
   *
   * @return {string}
   */
  public get url (): string {
    let auth = null
    if (this.authUsername !== 'installation') {
      if (this.authUsername != null || this.authPassword != null) {
        auth = `${this.authUsername}:${this.authPassword}`
      }
    }

    return URL.format({
      auth,
      host: this.host,
      pathname: `/${this.username}/${this.repository}.git`,
      protocol: 'https'
    })
  }

  /**
   * Sets the Git URL for the repository
   * NOTE: Auth code is case sensitive, so we can't lowercase the whole url
   *
   * @return {string}
   */
  public set url (p: string) {
    if (p.indexOf('github') === -1) {
      throw new Error('Given URL is not a GitHub repository')
    }

    // NOTE: This is A+ 10/10 string logic. Will not break ever.
    const httpPath = (p.startsWith('git@') ? p.replace('git@', 'https://') : p)
      .replace('://github.com:', '://github.com/')
      .replace(/\.git$/, '')

    const url = new URL.URL(httpPath)
    const [host, username, repository] = url.pathname.split('/')

    this.host = url.host
    this.username = username
    this.repository = repository
    this.authUsername = (url.username !== '') ? url.username : null
    this.authPassword = (url.password !== '') ? url.password : null

    // GitHub never sends auth codes as the username due to http security
    // Headers. This probably means it was parsed weird so we should fix it.
    if (this.authUsername != null && this.authPassword == null) {
      this.authPassword = this.authUsername
      this.authUsername = 'x-access-token'
    }
  }

  /**
   * Clones the repository to a folder
   *
   * @async
   * @param {string} p - The path to clone to
   * @param {string} [reference] - The branch to clone
   * @return {void}
   */
  public async clone (p: string, reference = this.reference): Promise<void> {
    const repo = await Git.Clone(this.url, p)

    const ref = await repo.getReference(reference)
    const commit = await ref.peel(Git.Object.TYPE.COMMIT)
    const branch = await repo.createBranch('houston', commit, true)

    await repo.checkoutBranch(branch, {})

    await this.recursiveClone(p)

    await fs.remove(path.resolve(p, '.git'))
  }

  /**
   * Returns a list of references this repository has
   * TODO: Try to figure out a more optimized way
   *
   * @async
   * @return {string[]}
   */
  public async references (): Promise<string[]> {
    const p = path.resolve(this.tmpFolder, uuid())
    const repo = await Git.Clone(this.url, p)

    const branches = await repo.getReferenceNames(Git.Reference.TYPE.LISTALL)

    await fs.remove(p)

    return branches
  }

  /**
   * Uploads an asset to a GitHub release.
   *
   * @async
   * @param {IPackage} pkg Package to upload
   * @param {IStage} stage
   * @param {string} [reference]
   * @return {IPackage}
   */
  public async uploadPackage (pkg: type.IPackage, stage: type.IStage, reference?: string) {
    if (pkg.githubId != null) {
      return pkg
    }

    return pkg

    const auth = await this.getAuthorization()

    const url = `${this.username}/${this.repository}/releases/tags/${reference}`
    const { body } = await agent
      .get(`https://api.github.com/repos/${url}`)
      .set('accept', 'application/vnd.github.v3+json')
      .set('user-agent', 'elementary-houston')
      .set('authorization', auth)

    if (body.upload_url == null) {
      throw new Error('No Upload URL for GitHub release')
    }

    // TODO: Should we remove existing assets that would conflict?
    const mime = await GitHub.getFileType(pkg.path)
    const stat = await fs.stat(pkg.path)
    const file = await fs.createReadStream(pkg.path)

    const res = await new Promise((resolve, reject) => {
      let data = ''

      const req = agent
        .post(body.upload_url.replace('{?name,label}', ''))
        .set('content-type', mime)
        .set('content-length', stat.size)
        .set('user-agent', 'elementary-houston')
        .set('authorization', auth)
        .query({ name: pkg.name })
        .query((pkg.description != null) ? { label: pkg.description } : {})
        .parse((response, fn) => {
          response.on('data', (chunk) => { data += chunk })
          response.on('end', fn)
        })
        .on('error', reject)
        .on('end', (err, response) => {
          if (err != null) {
            return reject(err)
          }

          try {
            return resolve(JSON.parse(data))
          } catch (err) {
            return reject(err)
          }
        })

      file
        .pipe(req)
        .on('error', reject)
        .on('close', () => resolve(data))
    })

    return { ...pkg }
  }

  /**
   * Uploads a log to GitHub as an issue with the 'AppCenter' label
   *
   * @async
   * @param {ILog} log
   * @param {IStage} stage
   * @param {string} [reference]
   * @return {ILog}
   */
  public async uploadLog (log: type.ILog, stage: type.IStage, reference?: string): Promise<type.ILog> {
    if (log.githubId != null) {
      return
    }

    const auth = await this.getAuthorization()

    const hasLabel = await agent
      .get(`https://api.github.com/repos/${this.username}/${this.repository}/labels/AppCenter`)
      .set('user-agent', 'elementary-houston')
      .set('authorization', auth)
      .then(() => true)
      .catch(() => false)

    if (!hasLabel) {
      await agent
        .post(`https://api.github.com/repos/${this.username}/${this.repository}/labels`)
        .set('user-agent', 'elementary-houston')
        .set('authorization', auth)
        .send({
          color: '4c158a',
          description: 'Issues related to releasing on AppCenter',
          name: 'AppCenter'
        })
    }

    const { body } = await agent
      .post(`https://api.github.com/repos/${this.username}/${this.repository}/issues`)
      .set('user-agent', 'elementary-houston')
      .set('authorization', auth)
      .send({
        body: log.body,
        labels: ['AppCenter'],
        title: log.title
      })

    return { ...log, githubId: body.id }
  }

  /**
   * Returns the http Authorization header value
   * NOTE: This should be private, but is public for easier testing.
   *
   * @async
   * @return {string}
   */
  public async getAuthorization (): Promise<string> {
    if (this.authUsername !== 'installation') {
      return `Bearer ${this.authPassword}`
    } else {
      const cachedToken = await this.cache.get(this.authPassword)

      if (cachedToken == null) {
        const token = await this.generateToken(Number(this.authPassword))
        await this.cache.set(this.authPassword, token)

        return `token ${token}`
      } else {
        return `token ${cachedToken}`
      }
    }
  }

  /**
   * Generates a json web token used for making app requests to GitHub.
   *
   * @async
   * @return {string}
   */
  protected async generateJwt (): Promise<string> {
    const keyPath = this.config.get('service.github.key')
    const key = await fs.readFile(keyPath, 'utf-8')
    const payload = {
      iat: Math.floor(Date.now() / 1000),
      iss: this.config.get('service.github.app')
    }
    const options = {
      algorithm: 'RS256',
      expiresIn: '1m'
    }

    return new Promise<string>((resolve, reject) => {
      jsonwebtoken.sign(payload, key, options, (err, token) => {
        if (err != null) {
          return reject(err)
        } else {
          return resolve(token)
        }
      })
    })
  }

  /**
   * Uses a json web token to generate an API usable authentication token for
   * GitHub.
   *
   * @async
   * @param {number} installation The GitHub app installation number
   * @return {string}
   */
  protected async generateToken (installation: number): Promise<string> {
    const jwt = await this.generateJwt()

    return agent
      .post(`https://api.github.com/app/installations/${installation}/access_tokens`)
      .set('accept', 'application/vnd.github.machine-man-preview+json')
      .set('user-agent', 'elementary-houston')
      .set('authorization', `Bearer ${jwt}`)
      .then((res) => res.body.token)
  }

  /**
   * Clones all of the Git submodules for a given repo path
   *
   * @async
   * @param {String} clonePath - Path of the repository
   * @return {void}
   */
  protected async recursiveClone (clonePath) {
    const repo = await Git.Repository.open(clonePath)

    await Git.Submodule.foreach(repo, async (submodule) => {
      await submodule.update(1, new Git.SubmoduleUpdateOptions())
      await this.recursiveClone(path.join(clonePath, submodule.path()))
    })
  }
}
