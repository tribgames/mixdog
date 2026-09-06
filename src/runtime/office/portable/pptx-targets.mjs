import { zipText } from './portable-opc.mjs';
import { containerInner, topLevelElements } from './portable-xml.mjs';
import { shapeIdentity } from './pptx-relations.mjs';

export async function resolvePptxTargets({ zip, slides }, operation) {
  const op = { ...operation };
  if (op.slideId != null) {
    const matches = slides.map((slide, index) => ({ slide, index })).filter(({ slide }) => String(slide.id) === String(op.slideId));
    if (matches.length !== 1) throw new Error(`PPTX slideId ${op.slideId} is missing or ambiguous`);
    const slide = matches[0].index + 1;
    if (op.slide != null && Number(op.slide) !== slide) throw new Error('PPTX slide and slideId identify different pages');
    op.slide = slide;
    delete op.slideId;
  }
  if (op.shapeId != null) {
    const slide = slides[Number(op.slide) - 1];
    if (!slide) throw new Error('shapeId requires a valid slide or slideId');
    const xml = await zipText(zip, slide.path);
    const tree = containerInner(xml, 'p:spTree');
    const shapes = topLevelElements(tree?.inner || '', ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
    const matches = shapes.map((shape, index) => ({ ...shapeIdentity(shape.xml), index }))
      .filter((shape) => String(shape.shapeId) === String(op.shapeId));
    if (matches.length !== 1) throw new Error(`PPTX shapeId ${op.shapeId} is missing or ambiguous`);
    const shape = matches[0].index + 1;
    if (op.shape != null && Number(op.shape) !== shape) throw new Error('PPTX shape and shapeId identify different elements');
    op.shape = shape;
    delete op.shapeId;
  }
  return op;
}
