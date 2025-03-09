const core = require('@actions/core')
const process = require('process')
const path = require('path')
const spawn = require('child_process').spawnSync

/// Gets the settings for this action, with default values filled in.
function getSettings() {
  // Default to the native processor as the host architecture
  // vsdevcmd accepts both amd64 and x64
  const hostArch =
    core.getInput('host_arch') ||
    process.env['PROCESSOR_ARCHITECTURE'].toLowerCase() // amd64, x86 or arm64
  const arch = core.getInput('arch') || hostArch
  const toolsetVersion = core.getInput('toolset_version') || null

  const components = core
    .getInput('components')
    .split(';')
    .filter(s => s.length != 0)

  if (!toolsetVersion) {
    // Include the latest target architecture compiler toolset by default
    switch (arch) {
      case 'arm64':
        components.push('Microsoft.VisualStudio.Component.VC.Tools.ARM64')
        break
      case 'arm64ec':
        components.push('Microsoft.VisualStudio.Component.VC.Tools.ARM64EC')
        break
      case 'arm':
        components.push('Microsoft.VisualStudio.Component.VC.Tools.ARM')
        break
      default:
        components.push('Microsoft.VisualStudio.Component.VC.Tools.x86.x64')
        break
    }
  }

  return {
    host_arch: hostArch,
    arch: arch,
    toolset_version: toolsetVersion,
    winsdk: core.getInput('winsdk') || null,
    vswhere: core.getInput('vswhere') || null,
    components: components,
    // Action inputs are stringly-typed, and Boolean("false") === true, so prefer:
    verbose: String(core.getInput('verbose')) === 'true',
  }
}

function findVSWhere(settings) {
  const vswhere = settings.vswhere || 'vswhere.exe'
  const vsInstallerPath = path.win32.join(
    process.env['ProgramFiles(x86)'],
    'Microsoft Visual Studio',
    'Installer',
  )
  const vswherePath = path.win32.resolve(vsInstallerPath, vswhere)
  console.log(`vswhere: ${vswherePath}`)
  return vswherePath
}

function findVSInstallDir(settings) {
  const vswherePath = findVSWhere(settings)

  const requiresArg = settings.components
    .map(comp => ['-requires', comp])
    .reduce((arr, pair) => arr.concat(pair), [])

  const vswhereArgs = [
    '-nologo',
    '-latest',
    '-products',
    '*',
    '-property',
    'installationPath',
  ].concat(requiresArg)

  console.log(`$ ${vswherePath} ${vswhereArgs.join(' ')}`)

  const vswhereResult = spawn(vswherePath, vswhereArgs, { encoding: 'utf8' })
  if (vswhereResult.error) throw vswhereResult.error

  if (settings.verbose) {
    const args = ['-nologo', '-latest', '-products', '*'].concat(requiresArg)
    const details = spawn(vswherePath, args, { encoding: 'utf8' })
    console.log(details.output.join(''))
  }

  const installPathList = vswhereResult.output
    .filter(s => !!s)
    .map(s => s.trim())
  if (installPathList.length == 0)
    throw new Error('Could not find compatible VS installation')

  const installPath = installPathList[installPathList.length - 1]
  console.log(`install: ${installPath}`)
  return installPath
}

function getVSDevCmdArgs(settings) {
  const args = [`-host_arch=${settings.host_arch}`, `-arch=${settings.arch}`]
  if (settings.toolset_version)
    args.push(`-vcvars_ver=${settings.toolset_version}`)
  if (settings.winsdk) args.push(`-winsdk=${settings.winsdk}`)
  return args
}

try {
  // this job has nothing to do on non-Windows platforms
  if (process.platform != 'win32') {
    process.exit(0)
  }

  var settings = getSettings()

  const installPath = findVSInstallDir(settings)
  core.setOutput('install_path', installPath)

  const vsDevCmdPath = path.win32.join(
    installPath,
    'Common7',
    'Tools',
    'vsdevcmd.bat',
  )
  console.log(`vsdevcmd: ${vsDevCmdPath}`)

  const vsDevCmdArgs = getVSDevCmdArgs(settings)
  const cmdArgs = ['/q', '/k', vsDevCmdPath, ...vsDevCmdArgs, '&&', 'set']
  console.log(`$ cmd ${cmdArgs.join(' ')}`)

  const cmdResult = spawn('cmd', cmdArgs, { encoding: 'utf8' })
  if (cmdResult.error) throw cmdResult.error

  const cmdOutput = cmdResult.output
    .filter(s => !!s)
    .map(s => s.split('\n'))
    .reduce((arr, sub) => arr.concat(sub), [])
    .filter(s => !!s)
    .map(s => s.trim())

  const completeEnv = cmdOutput
    .filter(s => s.indexOf('=') != -1)
    .map(s => s.split('=', 2))
  const newEnvVars = completeEnv.filter(([key, _]) => !process.env[key])
  const newPath = completeEnv
    .filter(([key, _]) => key == 'Path')
    .map(([_, value]) => value)
    .join(';')

  for (const [key, value] of newEnvVars) {
    core.exportVariable(key, value)
  }
  core.exportVariable('Path', newPath)

  console.log('environment updated')
} catch (error) {
  core.setFailed(error.message)
}
