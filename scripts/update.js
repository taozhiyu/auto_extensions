import { readFileSync, appendFileSync, writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { xml2js } from 'xml-js'

import { colorNames, modifierNames } from 'ansi-styles'
import styles from 'ansi-styles'

String.prototype.colorful = function (...colors) {
  const text = this,
    colorTypes = ['color', 'bgColor']
  if (
    colors.find(
      (color) => Object.prototype.toString.call(color) !== '[object String]',
    )
  )
    throw new Error('Invalid color')
  let ret = text
  colors.forEach((color, i) => {
    if ([...colorNames, ...modifierNames].includes(color)) {
      ret = styles[color].open + ret + styles[color].close
    } else if (color.startsWith('#')) {
      ret =
        styles[colorTypes[+!!i]].ansi(styles.hexToAnsi(color)) +
        ret +
        styles[colorTypes[+!!i]].close
    }
  })
  return ret
}

const getLatestVersion = async ({ github, id, core }) => {
  //获取最新版本信息
  core.startGroup('get latest info')

  const url = `https://clients2.google.com/service/update2/crx?response=xml&os=win&arch=x64&os_arch=x86_64&nacl_arch=x86-64&prod=chromecrx&prodchannel=&prodversion=200&lang=&acceptformat=crx3&x=id%3D${id}%26installsource%3Dondemand%26uc`

  const updateInfo = await github
    .request({
      method: 'GET',
      url,
    })
    .then(({ data }) => {
      const {
        gupdate: {
          app: {
            updatecheck: {
              _attributes: { version, codebase },
            },
          },
        },
      } = xml2js(data, { compact: true })
      return { version, codebase }
    })
    .catch((e) => {
      console.error('error happened', e)
      return {}
    })
  if (!updateInfo) {
    core.endGroup()
    core.setfailed('get update info failed')
    return
  }
  console.log(`Latest Version: 
${'version'.colorful('whiteBright', 'bgYellow')}: ${updateInfo.version.colorful(
    'yellow',
  )}
${'codebase'.colorful(
    'whiteBright',
    'bgGreen',
  )}: ${updateInfo.codebase.colorful('green')}`)
  core.endGroup()
  return updateInfo
}

const fetchAndUnzip = async ({ github, core, exec, url }) => {
  core.debug('request crx file')
  // 确保不重复(似乎没有必要？)Math.random().toString(36).slice(2) + '__' +
  const crxFileName = path.basename(url)
  const crxPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../temp/' + crxFileName,
  )
  const req = await github.request({
    method: 'GET',
    url,
  })
  appendFileSync(crxPath, Buffer.from(req.data))
  core.startGroup('ls')
  await exec.exec('ls -al', [], { cwd: './temp' })
  console.log('ls'.colorful('yellow') + " " + 'finished'.colorful('green'))
  core.endGroup()

  core.startGroup('unzip')
  try {
    await exec.exec('unzip ' + crxFileName + ' -d ' + path.basename(url, '.crx'), [], { cwd: './temp' })
    console.log('unzip'.colorful('yellow') + ' ' + 'finished'.colorful('green'))
  } catch (err) {
    if (!err.message.endsWith('exit code 1')) {
      core.info(err)
      core.setfailed('unzip failed')
    }
  }
  core.endGroup()

  core.startGroup('ls twice')
  await exec.exec('ls -al', [], { cwd: './temp' })
  console.log('ls'.colorful('yellow') + " " + 'finished'.colorful('green'))
  core.endGroup()
}

const doUpdate = async ({
  github,
  context,
  core,
  type,
  id,
  exec,
  io
}) => {
  const configPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../docs/updates/' + type + '/config.json',
  )
  const forceVersion = core.getInput('force-version')

  // 获取最新version
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  console.log(config)
  const updateInfo = await getLatestVersion({ github, id, core })
  if (forceVersion) updateInfo.version = forceVersion

  if (updateInfo.version === config.latestVersion) {
    core.setOutput('commit_message', '');
    core.info('No nee to update'.colorful('bgGreen'))
    return
  }
  core.info('update ready'.colorful('yellow'))
  try {
    await fetchAndUnzip({ github, core, url: updateInfo.codebase, exec })
  } catch (error) {
    core.setfailed('fetch & unzip failed')
  }

  const { default: handleMain } = await import('./modules/' + type + '.js')
  try {
    const result = await handleMain({ url: updateInfo.codebase, io })
    core.info('handle result:')
    console.log(result)
    if (!result || 0 !== result.code) {
      core.setfailed('handle error')
    }
    core.setOutput('commit_message', type + ' has automatically updated');
    config.latestVersion = updateInfo.version
    config.updateDate = new Date().toGMTString()
    const newConfig = { ...config, ...result.output }
    writeFileSync(configPath, JSON.stringify(newConfig, "", 4))
  } catch (error) {
    console.log(error)
    core.setfailed('handle error')
  }
}

export default doUpdate