import {Command, flags} from '@oclif/command'
import { readFileSync, writeFileSync, createWriteStream } from 'fs';
import * as turfHelpers from '@turf/helpers';

import { TilePathParams, TileType, TilePathGroup, TilePath, TileIndex } from 'sharedstreets'

const cliProgress = require('cli-progress');
const chalk = require('chalk');

export default class Movement extends Command {
  static description = 'links Uber Movement data sets with SharedStreets'

  static examples = [
    `$ shst-speeds movement polygon.geojson --movement-junctions=movement-junctions-to-osm-nodes-new-york-2018.csv --movement-segments=movement-segments-to-osm-ways-new-york-2018.csv  --movement-quarterly-speeds=movement-speeds-quarterly-by-hod-new-york-2018-Q4.csv 
    `,
  ]

  static flags = {
    help: flags.help({char: 'h'}),

    // flag with a value (-o, --out=FILE)
    out: flags.string({char: 'o', description: 'output file'}),
    'tile-source': flags.string({description: 'SharedStreets tile source', default: 'osm/planet-181224'}),
    'tile-hierarchy': flags.integer({description: 'SharedStreets tile hierarchy', default: 6}),
    'filter-day': flags.integer({description: 'filter day of month (applies only to hourly timeseries data sets)'}),
    'filter-hour': flags.integer({description: 'filter hour of day (applies to hourly and quarterly data sets)'}),
    'drive-left-side': flags.boolean({description: 'offset road geometries for left-side driving'}),
    'movement-segments': flags.string({description: 'Movement "segment" file (csv)'}),
    'movement-junctions': flags.string({description: 'Movement "junction" file (csv)'}),
    'movement-quarterly-speeds': flags.string({description: 'Movement quarterly speed file (csv)'}),
    'movement-hourly-speeds': flags.string({description: 'Movement hourly speed file (csv)'}),
    stats: flags.boolean({char: 's'})

    // flag with no value (-f, --force)
    //force: flags.boolean({char: 'f'}),
  }

  static args = [{name: 'file'}]

  async run() {
    const {args, flags} = this.parse(Movement)

    var content = readFileSync(args.file);
    var polygon = JSON.parse(content.toLocaleString());
  
    if(flags.out)
      this.log(chalk.bold.keyword('green')('  🗄️  Loading SharedStreets tiles...'));

    var params = new TilePathParams();
    params.source = flags['tile-source'];
    params.tileHierarchy = flags['tile-hierarchy'];
  
    var tilePathGroup = TilePathGroup.fromPolygon(polygon, 0, params);
    tilePathGroup.addType(TileType.METADATA);
    tilePathGroup.addType(TileType.GEOMETRY);
    tilePathGroup.addType(TileType.REFERENCE);
    tilePathGroup.addType(TileType.INTERSECTION);

    var tileIndex = new TileIndex();
    await tileIndex.indexTilesByPathGroup(tilePathGroup);
  
    this.log(chalk.bold.keyword('green')('  🗄️  Loading Movment segments...'));

    if(!flags['movement-segments']) {
      this.log(chalk.bold.keyword('orange')('  required Movement segments file not specified... use --movement-segments to locate file'));
      return;
    }

    var movementSegementsToWayIds:Map<string,string> = new Map();

    var segmentLines = readFileSync(flags['movement-segments']).toString().split("\n");
    var firstLine = true;
    for(var line of segmentLines) {
      if(!firstLine) {
        var parts = line.split(',');
        var segmentId = parts[0];
        var wayId = parts[1];
        if(tileIndex.osmWayIndex.has(wayId)) {
          movementSegementsToWayIds.set(segmentId, wayId);
        }
        else {
          //console.log('unable to find way: ' + wayId);
        }      
      }
      else 
        firstLine= false;
    }

    segmentLines = null;

    console.log("     total segments:" + movementSegementsToWayIds.size);

    if(!flags['movement-junctions']) {
      this.log(chalk.bold.keyword('orange')('  required Movement junctions file not specified... use --movement-junctions to locate file'));
      return;
    }

    this.log(chalk.bold.keyword('green')('  🗄️  Loading Movment junctions...'));

    var movementJunctionsToNodeIds:Map<string,string> = new Map();

    var junctionLines = readFileSync(flags['movement-junctions']).toString().split("\n");
    var firstLine = true;
    for(var line of junctionLines) {
      if(!firstLine) {
        var parts = line.split(',');
        var junctionId = parts[0];
        var nodeId = parts[1];
        if(tileIndex.osmNodeIndex.has(nodeId)) {
          movementJunctionsToNodeIds.set(junctionId , nodeId);
        }
        else {
          //console.log('unable to find way: ' + wayId);
        }      
      }
      else 
        firstLine= false;
    }

    junctionLines = null;

    console.log("     total junctions:" + movementJunctionsToNodeIds.size);

    var speedLines:string[] = [];
    
    if(flags['movement-quarterly-speeds'])
      speedLines = readFileSync(flags['movement-quarterly-speeds']).toString().split("\n");
    else if(flags['movement-hourly-speeds'])
      speedLines = readFileSync(flags['movement-hourly-speeds']).toString().split("\n");
    else {
      this.log(chalk.bold.keyword('orange')('  required quarterly or hourly speed data not specified... use --movement-quarterly-speeds or --movement-hourly-speeds to locate file'));
      return;
    }

    var outFile = flags.out;
    if(!outFile && flags['movement-quarterly-speeds'])
      outFile  = flags['movement-quarterly-speeds']  + '.out.geojson';
    else if(!outFile && flags['movement-hourly-speeds'])
      outFile  = flags['movement-hourly-speeds']  + '.out.geojson'

    this.log(chalk.bold.keyword('green')('  🚦 Processing Uber Movement speed data into: ' +  outFile));

    var outputStream = createWriteStream(outFile);
    outputStream.write('{"type": "FeatureCollection","features": [\n');

    var firstLine = true;
    var matchedSegments = 0;
    var unmatchedSegments = 0;
    var missingSegments = 0;

    const bar1 = new cliProgress.Bar({},{
      format: chalk.keyword('blue')(' {bar}') + ' {percentage}% | {value}/{total} ',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591'
    });
   
    bar1.start(speedLines.length, 0);

    var offset = 4;
    if(flags['drive-left-side']) 
      offset = -4;

    for(var line of speedLines) {
      bar1.increment();
      if(!firstLine) {
        var parts = line.split(',');

        if(flags['movement-quarterly-speeds']) {
          if(movementSegementsToWayIds.has(parts[3])) {

            // if(flags['movement-quarterly-speeds'] && flags['movement-quarterly-speeds'] != parts[2])
            //     continue;

            var geom = await tileIndex.geomFromOsm(movementSegementsToWayIds.get(parts[3]), movementJunctionsToNodeIds.get(parts[4]), movementJunctionsToNodeIds.get(parts[5]), offset);
            if(geom) {
              geom.properties['segment'] = parts[3]; 
              geom.properties['fromJunction'] = parts[4]; 
              geom.properties['toJunction'] = parts[5]; 
              geom.properties['wayId'] = movementSegementsToWayIds.get(parts[3]); 
              geom.properties['fromNodeId'] = movementSegementsToWayIds.get(parts[4]); 
              geom.properties['toNodeId'] = movementSegementsToWayIds.get(parts[5]); 
              geom.properties['year'] = parseInt(parts[0]);
              geom.properties['quarter'] = parseInt(parts[1]);
              geom.properties['hour'] = parseInt(parts[2]);
              geom.properties['mean'] = parseFloat(parts[6]);
              geom.properties['meanStd'] = parseFloat(parts[7]);
              geom.properties['p50'] = parseFloat(parts[8]);
              geom.properties['p85'] = parseFloat(parts[9]);
              
              if(matchedSegments > 0)
                outputStream.write(',');
              outputStream.write(JSON.stringify(geom) + '\n');

              matchedSegments++;
            }
            else {
              unmatchedSegments++;
            }
              
          }
          else {
              missingSegments++;
          }
        }
        else if(flags['movement-hourly-speeds']) {
          if(movementSegementsToWayIds.has(parts[3])) {
            var geom = await tileIndex.geomFromOsm(movementSegementsToWayIds.get(parts[3]), movementJunctionsToNodeIds.get(parts[4]), movementJunctionsToNodeIds.get(parts[5]), offset);
            if(geom) {
              geom.properties['segment'] = parts[3]; 
              geom.properties['fromJunction'] = parts[4]; 
              geom.properties['toJunction'] = parts[5]; 
              geom.properties['wayId'] = movementSegementsToWayIds.get(parts[3]); 
              geom.properties['fromNodeId'] = movementSegementsToWayIds.get(parts[4]); 
              geom.properties['toNodeId'] = movementSegementsToWayIds.get(parts[5]); 
              geom.properties['year'] = parseInt(parts[0]);
              geom.properties['quarter'] = parseInt(parts[1]);
              geom.properties['hour'] = parseInt(parts[2]);
              geom.properties['mean'] = parseFloat(parts[6]);
              geom.properties['meanStd'] = parseFloat(parts[7]);
              
              if(matchedSegments > 0)
                outputStream.write(',');
              outputStream.write(JSON.stringify(geom));

              matchedSegments++;
            }
            else {
              unmatchedSegments++;
            }
              
          }
          else {
              missingSegments++;
          }
        }
      }
      else 
        firstLine = false;
    }
    bar1.stop();

    speedLines = null;
    tileIndex = null;

    outputStream.write(']}');
    await outputStream.end();

    console.log("matched segments: " +  matchedSegments);
    console.log("unmatched segments: " +  unmatchedSegments);
    console.log("filtered segments (outside polygon boundary): " +  missingSegments);

  }
}


