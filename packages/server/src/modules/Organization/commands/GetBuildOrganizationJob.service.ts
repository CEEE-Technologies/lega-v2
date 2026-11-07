import { Queue } from 'bullmq';
import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ClsService } from 'nestjs-cls';
import {
  OrganizationBuildQueue,
  OrganizationBuildQueueJobPayload,
} from '../Organization.types';
import { ServiceError } from '@/modules/Items/ServiceError';

@Injectable()
export class GetBuildOrganizationBuildJob {
  constructor(
    @InjectQueue(OrganizationBuildQueue)
    private readonly organizationBuildQueue: Queue<OrganizationBuildQueueJobPayload>,
    private readonly cls: ClsService,
  ) {}

  /**
   * Gets the build job details by job ID. Only the user who started the
   * job can read it; anyone else is told it doesn't exist.
   * @param {string} jobId - The ID of the job to retrieve.
   * @returns {Promise<any>} - Returns the job details.
   */
  async getJobDetails(jobId: string): Promise<any> {
    const job = await this.organizationBuildQueue.getJob(jobId);
    const userId = this.cls.get<number>('userId');

    if (!job || !userId || Number(job.data?.userId) !== Number(userId)) {
      throw new ServiceError(
        'JOB.NOT_FOUND',
        'Job not found',
        null,
        HttpStatus.NOT_FOUND,
      );
    }
    const state = await job.getState();

    return {
      id: job.id,
      state,
      progress: job.progress,
      isCompleted: state === 'completed',
      isRunning: state === 'active',
      isWaiting: state === 'waiting' || state === 'waiting-children',
      isFailed: state === 'failed',
    };
  }
}
