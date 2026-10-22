import type { Producer, ProducerType } from '@prisma/client';
import { callDataService } from './client';
export const getProducers = (type: ProducerType) => callDataService<Producer[]>('spider/producers', { type });
export const getProducerById = (id: string) => callDataService<Producer | null>('spider/producer', { id });
export const updateProducerLastPostTime = (id: string) => callDataService<Producer>('spider/producerWatermark', { id });
