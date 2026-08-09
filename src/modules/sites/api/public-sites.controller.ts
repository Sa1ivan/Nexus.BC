import {
  Controller,
  Get,
  Param,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../../shared/http/public.decorator';
import { GetPublicSite } from '../application/get-public-site';
import { SitesApplicationErrorInterceptor } from './sites-application-error.interceptor';

@Public()
@UseInterceptors(SitesApplicationErrorInterceptor)
@Controller('v1/public/sites')
export class PublicSitesController {
  constructor(private readonly getPublicSite: GetPublicSite) {}

  @Get(':publicSlug')
  async getRoot(
    @Param('publicSlug') publicSlug: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const ifNoneMatch = request.headers['if-none-match'];
    const result = await this.getPublicSite.execute({
      publicSlug,
      ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
    });
    response.setHeader('ETag', result.etag);
    if (result.notModified) {
      response.status(304);
      return;
    }
    return result.representation;
  }

  @Get(':publicSlug/pages/:pageSlug')
  async getPage(
    @Param('publicSlug') publicSlug: string,
    @Param('pageSlug') pageSlug: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const ifNoneMatch = request.headers['if-none-match'];
    const result = await this.getPublicSite.execute({
      publicSlug,
      pageSlug,
      ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
    });
    response.setHeader('ETag', result.etag);
    if (result.notModified) {
      response.status(304);
      return;
    }
    return result.representation;
  }
}
