import {
  Controller,
  Post,
  Body,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import DxfParser from 'dxf-json';
import { inspect } from 'util';

// --- Type Definitions ---

interface DXFEntity {
  type: string;
  [key: string]: any;
}

interface DXFData {
  header?: { [key: string]: any };
  blocks?: any;
  entities: DXFEntity[];
  tables?: any;
  objects?: any;
}

interface LwPolylineEntity extends DXFEntity {
  type: 'LWPOLYLINE';
  vertices: { x: number; y: number }[];
  closed?: boolean;
  shape?: boolean;
}

interface LineEntity extends DXFEntity {
  type: 'LINE';
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
}

interface ArcEntity extends DXFEntity {
  type: 'ARC';
  center: { x: number; y: number };
  radius: number;
  startAngle: number;
  endAngle: number;
}

interface CircleEntity extends DXFEntity {
  type: 'CIRCLE';
  center: { x: number; y: number };
  radius: number;
}

interface UploadBody {
  dxfContent: string;
}

/**
 * Calculate the area of a polygon (given ordered vertices) using the shoelace formula.
 */
function calculateArea(points: { x: number; y: number }[]): number {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const { x: x1, y: y1 } = points[i];
    const { x: x2, y: y2 } = points[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

function roundNumber(num: number, decimals: number = 6): number {
  return Number(num.toFixed(decimals));
}

function pointKey(pt: { x: number; y: number }): string {
  return `${roundNumber(pt.x)}_${roundNumber(pt.y)}`;
}

// --- Controller Implementation ---

@Controller()
export class UploadController {
  @Post('upload')
  uploadDXF(@Body() body: UploadBody): any {
    const { dxfContent } = body;
    if (!dxfContent) {
      throw new HttpException(
        'No DXF content provided',
        HttpStatus.BAD_REQUEST,
      );
    }

    let dxf: DXFData;
    try {
      const parser = new DxfParser();
      dxf = parser.parseSync(dxfContent);
      console.log(inspect(dxf, { depth: null }));
    } catch (err: any) {
      throw new HttpException(
        'Error parsing DXF: ' + err.message,
        HttpStatus.BAD_REQUEST,
      );
    }

    // Force inches: treat conversion factor as 1.
    const conversionFactor = 1;

    let independentPierceCount = 0;
    let independentArea = 0;

    interface Segment {
      start: { x: number; y: number };
      end: { x: number; y: number };
    }
    const segments: Segment[] = [];

    dxf.entities.forEach((entity: DXFEntity) => {
      switch (entity.type) {
        case 'CIRCLE': {
          const circle = entity as CircleEntity;
          independentArea += Math.PI * Math.pow(circle.radius, 2);
          independentPierceCount += 1;
          break;
        }
        case 'LWPOLYLINE': {
          const poly = entity as LwPolylineEntity;
          if (poly.closed || poly.shape) {
            if (poly.vertices && poly.vertices.length > 2) {
              independentArea += calculateArea(poly.vertices);
            }
            independentPierceCount += 1;
          } else {
            independentPierceCount += 2;
          }
          break;
        }
        case 'LINE': {
          const line = entity as LineEntity;
          segments.push({ start: line.startPoint, end: line.endPoint });
          break;
        }
        case 'ARC': {
          const arc = entity as ArcEntity;
          const radStart = (arc.startAngle * Math.PI) / 180;
          const radEnd = (arc.endAngle * Math.PI) / 180;
          const startPoint = {
            x: arc.center.x + arc.radius * Math.cos(radStart),
            y: arc.center.y + arc.radius * Math.sin(radStart),
          };
          const endPoint = {
            x: arc.center.x + arc.radius * Math.cos(radEnd),
            y: arc.center.y + arc.radius * Math.sin(radEnd),
          };
          segments.push({ start: startPoint, end: endPoint });
          break;
        }
        default:
          break;
      }
    });

    interface Graph {
      [key: string]: Set<string>;
    }
    const graph: Graph = {};
    const pointsMap: { [key: string]: { x: number; y: number } } = {};

    segments.forEach((seg) => {
      const key1 = pointKey(seg.start);
      const key2 = pointKey(seg.end);
      if (!graph[key1]) {
        graph[key1] = new Set();
        pointsMap[key1] = seg.start;
      }
      if (!graph[key2]) {
        graph[key2] = new Set();
        pointsMap[key2] = seg.end;
      }
      graph[key1].add(key2);
      graph[key2].add(key1);
    });

    const visited = new Set<string>();
    const components: string[][] = [];
    for (const key in graph) {
      if (!visited.has(key)) {
        const comp: string[] = [];
        const stack = [key];
        while (stack.length > 0) {
          const current = stack.pop()!;
          if (!visited.has(current)) {
            visited.add(current);
            comp.push(current);
            graph[current].forEach((neighbor) => {
              if (!visited.has(neighbor)) {
                stack.push(neighbor);
              }
            });
          }
        }
        components.push(comp);
      }
    }

    let groupedPierceCount = 0;
    let groupedArea = 0;
    components.forEach((comp) => {
      const isClosed = comp.every((key) => graph[key].size === 2);
      if (isClosed && comp.length >= 3) {
        // Instead of traversing arbitrarily, sort points by angle relative to the centroid.
        const pts = comp.map((key) => pointsMap[key]);

        // Compute centroid.
        const centroid = pts.reduce(
          (acc, pt) => ({ x: acc.x + pt.x, y: acc.y + pt.y }),
          { x: 0, y: 0 },
        );
        centroid.x /= pts.length;
        centroid.y /= pts.length;

        // Sort by angle.
        pts.sort((a, b) => {
          const angleA = Math.atan2(a.y - centroid.y, a.x - centroid.x);
          const angleB = Math.atan2(b.y - centroid.y, b.x - centroid.x);
          return angleA - angleB;
        });

        groupedArea += calculateArea(pts);
        groupedPierceCount += 1;
      } else {
        groupedPierceCount += 2;
      }
    });

    const totalPierceCount = independentPierceCount + groupedPierceCount;
    const totalAreaInDrawingUnits = independentArea + groupedArea;

    // Since conversionFactor is forced to 1, the result is in square inches.
    const totalAreaInInches =
      totalAreaInDrawingUnits * Math.pow(conversionFactor, 2);

    return { pierceCount: totalPierceCount, area: totalAreaInInches };
  }
}
