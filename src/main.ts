import { ErrorMapper } from 'utils/ErrorMapper'

declare global {
  interface Memory {
    ranStartupCommands?: boolean
    jobQueue?: (CreepJob & CreepJobConfig)[]
  }

  interface CreepMemory {
    configurationName?: keyof typeof creepConfigurations
    error?: string
    currentJob?: CreepJob
  }
}

type CreepJob =
  | CreepJobs.MineEnergy
  | CreepJobs.StoreEnergy
  | CreepJobs.UpgradeController
  | CreepJobs.BuildStructure

type CreepJobConfig = {
  priority: number
}

namespace CreepJobs {
  export type MineEnergy = {
    type: 'mineEnergy'
    sourceId: Id<Source>
  }
  export type StoreEnergy = {
    type: 'storeEnergy'
    structureId: Id<StructureSpawn | StructureExtension>
  }
  export type UpgradeController = {
    type: 'upgradeController'
    controllerId: Id<StructureController>
  }
  export type BuildStructure = {
    type: 'buildStructure'
    pos: {
      x: number
      y: number
    }
  }
}

type CreepJobAction<T extends CreepJob> = {
  oneOff?: boolean
  chooseIf: (params: { creep: Creep }, job: T) => boolean
  perform: (params: { creep: Creep }, job: T) => void
  continueIf: (params: { creep: Creep }, job: T) => boolean
}

const mineEnergy: CreepJobAction<CreepJobs.MineEnergy> = {
  chooseIf: ({ creep }) => {
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      return false
    }

    // TODO if no more places to store energy?
    // but maybe we still need to mine it in advance?

    return true
  },
  perform: ({ creep }, job) => {
    const source = Game.getObjectById(job.sourceId)!
    const harvestResult = creep.harvest(source)

    switch (harvestResult) {
      case OK:
        return
      case ERR_NOT_IN_RANGE:
        creep.moveTo(source, {
          visualizePathStyle: {
            stroke: '#ffaa00',
          },
        })
        return
      default:
        creep.memory.error = `Harvesting failed with code ${harvestResult} for creep ${creep.name}`
        return
    }
  },
  continueIf: ({ creep }) => {
    return creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0
  },
}

const storeEnergy: CreepJobAction<CreepJobs.StoreEnergy> = {
  chooseIf: ({ creep }) => {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      return false
    }

    return true
  },
  perform: ({ creep }, job) => {
    const structure = Game.getObjectById(job.structureId)!
    const transferResult = creep.transfer(structure, RESOURCE_ENERGY)

    switch (transferResult) {
      case OK:
        return
      case ERR_NOT_IN_RANGE:
        const room = structure.room

        const constructionSite = creep.room.lookForAt(
          LOOK_CONSTRUCTION_SITES,
          creep.pos.x,
          creep.pos.y
        )[0]

        if (!constructionSite) {
          room.createConstructionSite(creep.pos, STRUCTURE_ROAD)
          addJob({
            type: 'buildStructure',
            pos: creep.pos,
            priority: 20,
          })
        }

        creep.moveTo(structure, {
          visualizePathStyle: {
            stroke: '#ffaa00',
          },
        })
        return
      default:
        creep.memory.error = `Transfer failed with code ${transferResult} for creep ${creep.name}`
        return
    }
  },
  continueIf: ({ creep }, job) => {
    const structure = Game.getObjectById(job.structureId)!
    return (
      creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
      structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
    )
  },
}

const upgradeController: CreepJobAction<CreepJobs.UpgradeController> = {
  chooseIf: ({ creep }, job) => {
    if (Object.values(Game.creeps).length < 3) {
      return false
    }

    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      return false
    }

    const controller = Game.getObjectById(job.controllerId)!
    if (controller.level === 2 && controller.ticksToDowngrade > 5000) {
      return false
    }

    return true
  },
  perform: ({ creep }, job) => {
    const controller = Game.getObjectById(job.controllerId)!
    const upgradeResult = creep.upgradeController(controller)

    switch (upgradeResult) {
      case OK:
        return
      case ERR_NOT_IN_RANGE:
        creep.moveTo(controller, {
          visualizePathStyle: {
            stroke: '#ffaa00',
          },
        })
        return
      default:
        creep.memory.error = `Transfer failed with code ${upgradeResult} for creep ${creep.name}`
        return
    }
  },
  continueIf: ({ creep }) => {
    return creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0
  },
}

const buildStructure: CreepJobAction<CreepJobs.BuildStructure> = {
  oneOff: true,
  chooseIf: ({ creep }, job) => {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      return false
    }

    return true
  },
  perform: ({ creep }, job) => {
    const constructionSite = creep.room.lookForAt(
      LOOK_CONSTRUCTION_SITES,
      job.pos.x,
      job.pos.y
    )[0]
    const buildResult = creep.build(constructionSite)

    switch (buildResult) {
      case OK:
        return
      case ERR_NOT_IN_RANGE:
        creep.moveTo(constructionSite, {
          visualizePathStyle: {
            stroke: '#ffaa00',
          },
        })
        return
      default:
        creep.memory.error = `Build failed with code ${buildResult} for creep ${creep.name}`
        return
    }
  },
  continueIf: ({ creep }, job) => {
    const constructionSite = creep.room.lookForAt(
      LOOK_CONSTRUCTION_SITES,
      job.pos.x,
      job.pos.y
    )[0]
    return (
      creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && !!constructionSite
    )
  },
}
const creepJobActions = {
  mineEnergy,
  storeEnergy,
  upgradeController,
  buildStructure,
}

let jobQueue = Memory.jobQueue || []
const addJob = (job: CreepJob & CreepJobConfig) => {
  jobQueue.push(job)
}

export const loop = ErrorMapper.wrapLoop(() => {
  performUtilJobs()
  runOnStart()

  const energyAvailable = Game.spawns.Spawn1.room.energyAvailable

  for (const creep of Object.values(Game.creeps)) {
    const job = creep.memory.currentJob ?? findJobForCreep(creep)
    if (!job) {
      creep.say(`❌ no job`)
      continue
    }

    creep.memory.currentJob = job
    const jobAction = creepJobActions[job.type]
    jobAction.perform({ creep }, job as any)
    // creep.say(`🔧 ${job.type}`)
    if (!jobAction.continueIf({ creep }, job as any)) {
      creep.memory.currentJob = undefined
      if (jobAction.oneOff) {
        jobQueue = jobQueue.filter(
          (j) => JSON.stringify(j) !== JSON.stringify(job)
        )
      }
    }
  }

  for (const spawn of Object.values(Game.spawns)) {
    const job = findJobForSpawn(spawn)
    if (!job) {
      continue
    }

    job.perform()
  }

  Memory.jobQueue = jobQueue
})

function findJobForCreep(creep: Creep) {
  const job = [...jobQueue]
    .sort((a, b) => b.priority - a.priority)
    .filter((job) => {
      const configurationName = creep.memory.configurationName
      if (!configurationName) {
        return false
      }
      const config = creepConfigurations[configurationName]

      return (
        config.jobs.includes(job.type) &&
        creepJobActions[job.type].chooseIf({ creep }, job as any)
      )
    })[0]

  return job as CreepJob
}

const creepConfigurations = {
  basicCreep: {
    body: () => [WORK, CARRY, MOVE],
    jobs: ['mineEnergy', 'storeEnergy', 'upgradeController', 'buildStructure'],
  },
} as const

function findJobForSpawn(spawn: StructureSpawn) {
  const jobs = {
    spawnCreeps: {
      priority: 50,
      perform: () => {
        const configurationName = 'basicCreep'
        const config = creepConfigurations[configurationName]
        spawn.spawnCreep(config.body(), `${configurationName} ${Game.time}`, {
          memory: {
            configurationName,
          },
        })
      },
    },
  }

  const chosenJob = Object.values(jobs).sort(
    (a, b) => b.priority - a.priority
  )[0]
  return chosenJob
}

function performUtilJobs() {
  for (const name in Memory.creeps) {
    if (!(name in Game.creeps)) {
      delete Memory.creeps[name]
    }
  }

  const room = Game.spawns.Spawn1.room
  const expensionConstructionSites = room.find(FIND_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_EXTENSION,
  })

  for (const site of expensionConstructionSites) {
    if (
      jobQueue.some(
        (job) =>
          job.type === 'buildStructure' &&
          job.pos.x === site.pos.x &&
          job.pos.y === site.pos.y
      )
    ) {
      continue
    }

    addJob({
      type: 'buildStructure',
      priority: 80,
      pos: site.pos,
    })
  }
}

function runOnStart() {
  if (!Memory.ranStartupCommands) {
    spawnFirstCreep()

    const closestSource =
      Game.spawns.Spawn1.pos.findClosestByPath(FIND_SOURCES)!

    addJob({
      type: 'mineEnergy',
      sourceId: closestSource.id,
      priority: 30,
    })

    addJob({
      type: 'storeEnergy',
      structureId: Game.spawns.Spawn1.id,
      priority: 40,
    })

    addJob({
      type: 'upgradeController',
      controllerId: Object.values(Game.structures).find(
        (structure) => structure.structureType === STRUCTURE_CONTROLLER
      )!.id as Id<StructureController>,
      priority: 60,
    })

    Memory.ranStartupCommands = true
  }
}

function spawnFirstCreep() {
  for (const name in Game.spawns) {
    const spawn = Game.spawns[name]
    const configurationName = 'basicCreep'
    const config = creepConfigurations[configurationName]
    if (spawn.spawning) {
      continue
    }
    const spawnFirstCreepResult = spawn.spawnCreep(
      config.body(),
      'firstCreep',
      {
        memory: {
          configurationName,
        },
      }
    )
    if (spawnFirstCreepResult !== OK) {
      console.log(
        `Spawning first creep failed with code ${spawnFirstCreepResult}`
      )
    }
  }
}
